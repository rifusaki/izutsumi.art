import { getGalleryImages } from "../_utils/r2-gallery.js";

export default async function () {
	const images = await getGalleryImages();
	const tags = new Set();
	images.forEach(img => {
		img.tags.forEach(tag => tags.add(tag));
	});
	return Array.from(tags).sort();
}
