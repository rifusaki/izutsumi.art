
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import fs from "node:fs/promises";
import path from "node:path";

let cachedImages = null;
let client = null;

export function getR2Client() {
	if (client) return client;

	if (!process.env.R2_ACCOUNT_ID || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY) {
		return null;
	}

	client = new S3Client({
		region: "auto",
		endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
		credentials: {
			accessKeyId: process.env.R2_ACCESS_KEY_ID,
			secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
		},
	});
	return client;
}

// Helper to recursively walk a directory
async function getLocalFiles(dir) {
	try {
		const dirents = await fs.readdir(dir, { withFileTypes: true });
		const files = await Promise.all(dirents.map((dirent) => {
			const res = path.resolve(dir, dirent.name);
			return dirent.isDirectory() ? getLocalFiles(res) : res;
		}));
		return files.flat();
	} catch (e) {
		console.error(`Error reading directory ${dir}:`, e);
		return [];
	}
}

export async function getGalleryImages() {
	if (cachedImages) return cachedImages;

	// Load manual metadata override
	let metadata = {};
	try {
		const metadataPath = path.join(process.cwd(), "_data", "galleryMetadata.json");
		const metadataContent = await fs.readFile(metadataPath, "utf8");
		metadata = JSON.parse(metadataContent);
	} catch (e) {
		// No metadata file or invalid JSON, ignore
	}

	// Local source mode
	if (process.env.LOCAL_SOURCE) {
		const localSourcePath = path.resolve(process.cwd(), process.env.LOCAL_SOURCE);
		console.log(`Using local: ${localSourcePath}`);

		try {
			// Check if dir exists
			await fs.access(localSourcePath);

			const allFiles = await getLocalFiles(localSourcePath);
			cachedImages = await Promise.all(allFiles
				.filter(pk => /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(pk))
				.map(async (absolutePath) => {
					// Get key relative to LOCAL_SOURCE root to match R2 behavior
					const relativeKey = path.relative(localSourcePath, absolutePath);
					// Normalize separator to / for key consistency
					const key = relativeKey.split(path.sep).join("/");
					
					const folder = path.dirname(key);
					let tags = new Set();
					
					// Tag from folder (if not root)
					if (folder && folder !== ".") {
						tags.add(folder);
					}
					
					const stat = await fs.stat(absolutePath);
					
					return {
						key: key,
						url: absolutePath, // Pass absolute local path to eleventy-img
						lastModified: stat.mtime,
						size: stat.size,
						tags: Array.from(tags),
						description: (metadata[key] && metadata[key].description) || "",
						credits: (metadata[key] && metadata[key].credits) || null
					};
				})
			);

			// Sort randomly for gallery display
			cachedImages.sort(() => Math.random() - 0.5);

			console.log(`Loaded ${cachedImages.length} images from local source`);
			return cachedImages;

		} catch (e) {
			console.error("Error processing local source:", e.message);
			return [];
		}
	}


	// R2 mode
	const s3 = getR2Client();
	if (!s3 || !process.env.R2_BUCKET_NAME) {
		console.warn("R2 environment variables missing. Gallery will be empty.");
		return [];
	}

	const bucketName = process.env.R2_BUCKET_NAME;
	const publicDomain = process.env.R2_PUBLIC_DOMAIN || "";

	let allObjects = [];
	let continuationToken = undefined;

	try {
		do {
			const command = new ListObjectsV2Command({
				Bucket: bucketName,
				ContinuationToken: continuationToken,
			});
			const response = await s3.send(command);
			if (response.Contents) {
				allObjects.push(...response.Contents);
			}
			continuationToken = response.NextContinuationToken;
		} while (continuationToken);

		// Process images in parallel to resolve signed URLs
		cachedImages = await Promise.all(allObjects
			.filter(obj => /\.(jpg|jpeg|png|webp|avif|gif)$/i.test(obj.Key))
			.map(async obj => {
				const key = obj.Key;
				const folder = path.dirname(key);
				
				let tags = new Set();
				
				// Tag from folder (if not root)
				if (folder && folder !== ".") {
					tags.add(folder);
				}

				// Generate signed URL if public domain fails or it is the private endpoint
				const domain = publicDomain.replace(/\/$/, "");
				let url = domain ? `${domain}/${key}` : key;
				
				if (!domain || domain.includes("r2.cloudflarestorage.com")) {
					const command = new GetObjectCommand({
						Bucket: bucketName,
						Key: key,
					});
					// Signed URL valid for 1 hour
					url = await getSignedUrl(s3, command, { expiresIn: 3600 });
				}

				return {
					key: key,
					url: url,
					lastModified: obj.LastModified,
					size: obj.Size,
					tags: Array.from(tags),
					description: (metadata[key] && metadata[key].description) || "",
					credits: (metadata[key] && metadata[key].credits) || null
				};
			}));

		// Sort randomly for gallery display
		cachedImages.sort(() => Math.random() - 0.5);

		console.log(`Loaded ${cachedImages.length} images from R2`);
		return cachedImages;

	} catch (err) {
		console.error("Error fetching from R2:", err);
		return [];
	}
}
