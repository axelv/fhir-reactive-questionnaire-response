import { defineConfig } from "vite";

export default defineConfig({
  root: "demo",
  base: "/fhir-reactive-questionnaire-response/",
  build: {
    outDir: "../dist-demo",
    emptyOutDir: true,
  },
});
