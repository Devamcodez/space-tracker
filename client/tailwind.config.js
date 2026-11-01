/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          900: '#0a0c10',
          800: '#0e1117',
          700: '#131720',
          600: '#181c23',
        },
        accent: {
          blue: '#4f8ef7',
          teal: '#2fe8b0',
        },
      },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
};
