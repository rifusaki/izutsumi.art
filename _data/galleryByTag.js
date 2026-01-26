import { getGalleryImages } from "../_utils/r2-gallery.js";

export default async function () {
	const images = await getGalleryImages();
	const map = new Map();

	images.forEach(img => {
		img.tags.forEach(tag => {
			if (!map.has(tag)) {
				map.set(tag, { tagName: tag, images: [] });
			}
			map.get(tag).images.push(img);
		});
	});

	// Return array of objects for pagination
	return Array.from(map.values()).sort((a, b) => a.tagName.localeCompare(b.tagName));
}
