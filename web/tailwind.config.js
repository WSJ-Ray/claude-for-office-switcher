/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    borderRadius: {
      none: '0',
      sm: '2px',
      DEFAULT: '4px',
      md: '6px',
      lg: '6px',
      xl: '8px',
      '2xl': '8px',
      full: '9999px',
    },
    extend: {
      colors: {
        office: {
          50: '#f5f9fd',
          100: '#e8f2fb',
          200: '#cfe4f5',
          300: '#9bc9ed',
          400: '#62a8df',
          500: '#2886cf',
          600: '#0f6cbd',
          700: '#115ea3',
          800: '#0f548c',
          900: '#0c3b5e',
          950: '#082338',
        },
        cyan: {
          50: '#f5f9fd',
          100: '#e8f2fb',
          200: '#cfe4f5',
          300: '#9bc9ed',
          400: '#62a8df',
          500: '#2886cf',
          600: '#0f6cbd',
          700: '#115ea3',
          800: '#0f548c',
          900: '#0c3b5e',
          950: '#082338',
        },
        slate: {
          50: '#fafafa',
          100: '#f3f3f3',
          200: '#e5e5e5',
          300: '#d1d1d1',
          400: '#707070',
          500: '#616161',
          600: '#525252',
          700: '#424242',
          800: '#292929',
          900: '#1f1f1f',
          950: '#171717',
        },
        bg: 'var(--bg)',
        'bg-card': 'var(--bg-card)',
        'bg-elevated': 'var(--bg-elevated)',
        border: 'var(--border)',
        primary: 'var(--primary)',
        'primary-fg': 'var(--primary-fg)',
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-muted': 'var(--text-muted)',
        'text-tertiary': 'var(--text-tertiary)'
      },
      fontFamily: {
        sans: ['Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', 'Microsoft YaHei UI', 'system-ui', 'sans-serif'],
        mono: ['Cascadia Mono', 'Cascadia Code', 'Consolas', 'SFMono-Regular', 'ui-monospace', 'monospace']
      },
      transitionDuration: {
        150: '150ms',
        200: '200ms',
      },
    }
  },
  plugins: []
}
