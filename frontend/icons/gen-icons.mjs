// Generates icon-192.png and icon-512.png using only Node built-ins (no deps).
// Uses a minimal PNG encoder — draws a solid rounded-rect background + text via SVG→PNG via sips (macOS).
import { execSync, spawnSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const dir = path.dirname(fileURLToPath(import.meta.url));

const sizes = [192, 512];

for (const size of sizes) {
  const rx = Math.round(size * 0.208); // ~40/192 ratio
  const fontSize = Math.round(size * 0.57);
  const labelSize = Math.round(size * 0.145);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${rx}" fill="#1a1a2e"/>
  <rect x="4" y="4" width="${size-8}" height="${size-8}" rx="${rx-4}" fill="#16213e"/>
  <text x="${size/2}" y="${size*0.68}" font-size="${fontSize}" text-anchor="middle" font-family="Apple Color Emoji,system-ui">🫧</text>
  <text x="${size/2}" y="${size*0.92}" font-size="${labelSize}" font-weight="900" text-anchor="middle" font-family="-apple-system,system-ui" fill="#7c5cd8">BOB</text>
</svg>`;

  const svgPath = path.join(dir, `_tmp_${size}.svg`);
  const pngPath = path.join(dir, `icon-${size}.png`);
  writeFileSync(svgPath, svg);

  // macOS `sips` can convert SVG→PNG natively
  const result = spawnSync('sips', ['-s', 'format', 'png', svgPath, '--out', pngPath], { encoding: 'utf8' });
  unlinkSync(svgPath);

  if (result.status === 0) {
    console.log(`✓ icon-${size}.png`);
  } else {
    console.error(`✗ icon-${size}.png failed:`, result.stderr);
  }
}
