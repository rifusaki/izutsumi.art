import "dotenv/config";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { getR2Client } from "../_utils/r2-gallery.js";

const TARGET_WIDTHS = [150, 300, 600];
const BUCKET = process.env.R2_BUCKET_NAME || "izutsumi";
const SOURCE_DIR = process.env.LOCAL_ORIGIN;

async function walk(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = await Promise.all(
		entries.map(async (entry) => {
			const fullPath = join(dir, entry.name);
			if (entry.isDirectory()) return walk(fullPath);
			if (entry.isFile() && extname(entry.name).toLowerCase() === ".webp") return fullPath;
			return [];
		}),
	);
	return files.flat();
}

async function processImage(filePath, client) {
	const relativeKey = relative(SOURCE_DIR, filePath);

	try {
		const buffer = await readFile(filePath);
		const metadata = await sharp(buffer).metadata();

		if (!metadata.width) {
			console.warn(`Skipping ${relativeKey}: cannot determine width`);
			return { success: false, reason: "no width" };
		}

		const widthsToGenerate = TARGET_WIDTHS.filter((w) => metadata.width > w);

		if (widthsToGenerate.length === 0) {
			console.log(`Skipping ${relativeKey}: original width ${metadata.width}px ≤ all targets`);
			return { success: true, skipped: true };
		}

		const widthLabels = widthsToGenerate.map((w) => `${w}w`).join(", ");
		console.log(`Processing ${relativeKey} (${metadata.width}px) → ${widthLabels}`);

		await Promise.all(
			widthsToGenerate.map(async (targetWidth) => {
				const resized = await sharp(buffer)
					.resize({ width: targetWidth, withoutEnlargement: true })
					.webp()
					.toBuffer();

				const extIndex = relativeKey.lastIndexOf(".");
				const base = relativeKey.slice(0, extIndex);
				const ext = relativeKey.slice(extIndex);
				await client.send(
					new PutObjectCommand({
						Bucket: BUCKET,
						Key: `${base}.${targetWidth}w${ext}`,
						Body: resized,
						ContentType: "image/webp",
					}),
				);
			}),
		);

		return { success: true };
	} catch (error) {
		console.error(`Failed to process ${relativeKey}:`, error.message);
		return { success: false, reason: error.message };
	}
}

async function main() {
	const client = getR2Client();
	if (!client) {
		console.error(
			"R2 client not configured. Check R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.",
		);
		process.exit(1);
	}

	console.log(`Scanning source directory: ${SOURCE_DIR}`);
	const files = await walk(SOURCE_DIR);
	console.log(`Found ${files.length} webp images`);

	if (files.length === 0) {
		console.warn("No webp images found. Exiting.");
		process.exit(0);
	}

	let succeeded = 0;
	let skipped = 0;
	let failed = 0;

	for (const file of files) {
		const result = await processImage(file, client);
		if (result.skipped) {
			skipped++;
		} else if (result.success) {
			succeeded++;
		} else {
			failed++;
		}
	}

	console.log(`Done! Processed ${succeeded} images, skipped ${skipped}, ${failed} failures.`);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
