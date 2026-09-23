/**
 * Original brand-colored sample artwork, written to /home/user/Pictures on first run
 * so the gallery isn't empty. Plain SVG strings — no scripts, no external refs.
 */

const W = 640;
const H = 480;

/** Geometric eight-point star lattice (girih-inspired), navy on gold. */
function starPattern(): string {
  const cx = W / 2;
  const cy = H / 2;
  let stars = '';
  const cols = 6;
  const rows = 5;
  const cellW = W / cols;
  const cellH = H / rows;
  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const x = c * cellW;
      const y = r * cellH;
      const s = 26;
      stars += `<path transform="translate(${x} ${y})" d="M0 ${-s} L${s * 0.28} ${-s * 0.28} L${s} 0 L${s * 0.28} ${s * 0.28} L0 ${s} L${-s * 0.28} ${s * 0.28} L${-s} 0 L${-s * 0.28} ${-s * 0.28} Z" fill="none" stroke="#E3B650" stroke-width="1.4" stroke-opacity="0.55"/>`;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
    `<rect width="${W}" height="${H}" fill="#16264F"/>` +
    `<rect width="${W}" height="${H}" fill="url(#g1)"/>` +
    `<defs><radialGradient id="g1" cx="50%" cy="50%" r="75%">` +
    `<stop offset="0" stop-color="#22386F"/><stop offset="1" stop-color="#0B1530"/></radialGradient></defs>` +
    stars +
    `<g stroke="#F0CF7A" stroke-width="2.4" fill="none">` +
    `<path d="M${cx} ${cy - 90} L${cx + 78} ${cy - 28} L${cx + 48} ${cy + 72} L${cx - 48} ${cy + 72} L${cx - 78} ${cy - 28} Z"/>` +
    `</g>` +
    `<circle cx="${cx}" cy="${cy}" r="10" fill="#E3B650"/>` +
    `</svg>`
  );
}

/** Desert dunes at dusk — layered gold/royal gradients with a warm sun. */
function dunesAtDusk(): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
    `<defs>` +
    `<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#0E1A3A"/><stop offset="0.55" stop-color="#6f5a3a"/><stop offset="1" stop-color="#E3B650"/>` +
    `</linearGradient>` +
    `<linearGradient id="dune1" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#8F6412"/><stop offset="1" stop-color="#4a3a17"/>` +
    `</linearGradient>` +
    `<linearGradient id="dune2" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="#3a2c14"/><stop offset="1" stop-color="#1a140a"/>` +
    `</linearGradient>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#sky)"/>` +
    `<circle cx="${W * 0.72}" cy="${H * 0.36}" r="54" fill="#F0CF7A" opacity="0.9"/>` +
    `<circle cx="${W * 0.72}" cy="${H * 0.36}" r="80" fill="#F0CF7A" opacity="0.25"/>` +
    `<path d="M0 ${H * 0.62} Q ${W * 0.22} ${H * 0.5} ${W * 0.48} ${H * 0.6} T ${W} ${H * 0.55} V ${H} H0 Z" fill="url(#dune1)"/>` +
    `<path d="M0 ${H * 0.8} Q ${W * 0.3} ${H * 0.68} ${W * 0.6} ${H * 0.78} T ${W} ${H * 0.74} V ${H} H0 Z" fill="url(#dune2)"/>` +
    `</svg>`
  );
}

/** Crescent night — midnight sky, gold crescent moon, a scatter of stars. */
function crescentNight(): string {
  let stars = '';
  let seed = 7;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  for (let i = 0; i < 60; i++) {
    const x = Math.round(rand() * W);
    const y = Math.round(rand() * H * 0.7);
    const r = rand() < 0.85 ? 1 : 1.8;
    stars += `<circle cx="${x}" cy="${y}" r="${r}" fill="#F7F1E3" opacity="${(0.4 + rand() * 0.6).toFixed(2)}"/>`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">` +
    `<defs><radialGradient id="night" cx="30%" cy="20%" r="90%">` +
    `<stop offset="0" stop-color="#16264F"/><stop offset="1" stop-color="#0B1530"/></radialGradient>` +
    `<mask id="moonMask"><rect width="${W}" height="${H}" fill="black"/>` +
    `<circle cx="180" cy="150" r="70" fill="white"/><circle cx="210" cy="135" r="66" fill="black"/></mask>` +
    `</defs>` +
    `<rect width="${W}" height="${H}" fill="url(#night)"/>` +
    stars +
    `<circle cx="180" cy="150" r="70" fill="#E3B650" mask="url(#moonMask)"/>` +
    `<circle cx="180" cy="150" r="76" fill="none" stroke="#F0CF7A" stroke-opacity="0.25" stroke-width="6"/>` +
    `</svg>`
  );
}

export interface SampleImage { name: string; svg: string }

export function sampleImages(): SampleImage[] {
  return [
    { name: 'نمط النجمة.svg', svg: starPattern() },
    { name: 'كثبان عند الغسق.svg', svg: dunesAtDusk() },
    { name: 'ليلة الهلال.svg', svg: crescentNight() },
  ];
}
