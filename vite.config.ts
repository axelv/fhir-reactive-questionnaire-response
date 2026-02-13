import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "demo",
  base: "/fhir-reactive-questionnaire-response/",
  plugins: [react()],
  build: {
    outDir: "../dist-demo",
    emptyOutDir: true,
  },
});
