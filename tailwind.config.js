/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        panel: {
          bg: '#1e1e1e',
          sidebar: '#252526',
          border: '#3c3c3c',
          hover: '#2a2d2e',
          active: '#37373d',
        },
      },
    },
  },
  plugins: [],
}
