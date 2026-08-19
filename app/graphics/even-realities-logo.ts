import { GrayImage } from "./image";
import { loadPngAsGrayImage } from "./imagefile";

const LOGO_PATH = "images/EvenRealitiesLogo.png";

let sourceLogo: GrayImage | null | undefined;
const scaledLogos = new Map<number, GrayImage>();

/** Render the bundled Even Realities logo at launcher/sidebar icon size. */
export function renderEvenRealitiesLogo(size: number): GrayImage | null {
  const targetSize = Math.max(1, Math.round(size));
  const cached = scaledLogos.get(targetSize);
  if (cached) return cached;

  if (sourceLogo === undefined) {
    try {
      sourceLogo = loadPngAsGrayImage(LOGO_PATH);
    } catch (error) {
      console.warn(`Could not load ${LOGO_PATH}: ${error}`);
      sourceLogo = null;
    }
  }
  if (!sourceLogo) return null;

  const scaled = scaleToFit(sourceLogo, targetSize, targetSize);
  scaledLogos.set(targetSize, scaled);
  return scaled;
}

function scaleToFit(source: GrayImage, maxWidth: number, maxHeight: number): GrayImage {
  const scale = Math.min(maxWidth / source.width, maxHeight / source.height, 1);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  if (width === source.width && height === source.height) return source;

  const output = new GrayImage(width, height, 0);
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(source.height - 1, Math.floor(((y + 0.5) * source.height) / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(source.width - 1, Math.floor(((x + 0.5) * source.width) / width));
      output.pixels[y * width + x] = source.pixels[sourceY * source.width + sourceX]!;
    }
  }
  return output;
}
