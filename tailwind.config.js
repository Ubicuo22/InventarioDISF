/** @type {import('tailwindcss').Config} */

// Un solo verde de marca (23 sep 2026). Antes competían tres: --accent
// (#4CAF72 / #1E5C3A en style.css), el esmeralda y el green de Tailwind, con
// overrides de CSS encimados que además volvían sólidos los fondos
// translúcidos. Ahora `green` ES la paleta de marca: Tailwind genera bien
// cada tono y cada opacidad, sin parches. El 500 es --accent-dark y el 800
// es --accent (modo claro). No usar la paleta esmeralda de Tailwind — lo
// vigila tests/verde-marca.test.js.
const verdeMarca = {
  50:  '#EEF8F2',
  100: '#D5EFDF',
  200: '#B4E3C7',
  300: '#9EDBB8',
  400: '#66CC8C',
  500: '#4CAF72',
  600: '#3A9460',
  700: '#2E7D52',
  800: '#1E5C3A',
  900: '#143D28',
  950: '#0B2517',
}

module.exports = {
  content: [
    './public/**/*.html',
    './public/js/**/*.js',
  ],
  theme: {
    extend: {
      colors: {
        green:   verdeMarca,
      },
    },
  },
  plugins: [],
}
