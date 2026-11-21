import type { Config } from "tailwindcss";
import animate from "tailwindcss-animate";

/**
 * The palette is defined once, in `globals.css`, as HSL channel triplets so
 * Tailwind can apply opacity modifiers (`bg-accent/12`). Light and dark mode
 * swap the values in CSS rather than in JavaScript, which keeps every
 * component free of theme conditionals.
 */
const token = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

const config: Config = {
  darkMode: ["class"],
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    container: {
      center: true,
      padding: "1.5rem",
      screens: { "2xl": "1400px" },
    },
    extend: {
      colors: {
        background: token("background"),
        foreground: token("foreground"),
        surface: token("surface"),
        "surface-muted": token("surface-muted"),
        muted: token("muted"),
        "muted-foreground": token("muted-foreground"),
        border: token("border"),
        input: token("input"),
        ring: token("ring"),
        primary: {
          DEFAULT: token("primary"),
          foreground: token("primary-foreground"),
        },
        accent: {
          DEFAULT: token("accent"),
          foreground: token("accent-foreground"),
        },
        success: token("success"),
        warning: token("warning"),
        danger: token("danger"),

        // Brand aliases. These resolve to the semantic tokens above so the
        // familiar charcoal / concrete / steel / copper vocabulary keeps
        // working while still inverting correctly in dark mode.
        charcoal: token("foreground"),
        concrete: token("background"),
        steel: token("muted-foreground"),
        copper: token("accent"),
        paper: token("surface"),
        white: "#FFFFFF",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 4px)",
        sm: "calc(var(--radius) - 6px)",
      },
      boxShadow: {
        panel: "0 1px 2px rgba(23,26,29,0.04), 0 8px 24px rgba(23,26,29,0.06)",
        lift: "0 12px 40px rgba(23,26,29,0.14)",
        "lift-dark": "0 12px 40px rgba(0,0,0,0.55)",
        "focus-copper": "0 0 0 3px hsl(var(--accent) / 0.18)",
      },
      keyframes: {
        rise: {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        fade: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "slide-in-right": {
          "0%": { transform: "translateX(16px)", opacity: "0" },
          "100%": { transform: "translateX(0)", opacity: "1" },
        },
      },
      animation: {
        rise: "rise 220ms ease-out both",
        fade: "fade 160ms ease-out both",
        shimmer: "shimmer 1.6s linear infinite",
        "slide-in-right": "slide-in-right 200ms ease-out both",
      },
    },
  },
  plugins: [animate],
};

export default config;
