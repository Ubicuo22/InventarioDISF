/** @type {import('tailwindcss').Config} */

// Verde de marca = `green` estándar de Tailwind, el mismo que usa Electron
// (ubicuo-green: #22C55E / #15803D, auditoría de contraste del 22 sep 2026).
// Los tokens --accent / --color-primary(-solid) de style.css apuntan a esos
// mismos tonos. No usar la paleta esmeralda — lo vigila
// tests/verde-marca.test.js.
module.exports = {
  content: [
    './public/**/*.html',
    './public/js/**/*.js',
  ],
  theme: { extend: {} },
  plugins: [],
}
