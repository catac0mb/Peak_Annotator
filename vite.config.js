import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// IMPORTANT: Set `base` to your GitHub repo name with slashes, e.g. "/peak-annotator/"
// This makes all asset URLs work correctly on GitHub Pages.
// If your repo is at https://username.github.io/my-study/ then base = "/my-study/"
export default defineConfig({
  plugins: [react()],
  base: "/Peak_Annotator/",   // <-- change this to match your exact repo name
});
