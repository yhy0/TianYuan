import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:39876",
      "/mcp": "http://127.0.0.1:39876",
      "/admin": "http://127.0.0.1:39876",
      "/account": "http://127.0.0.1:39876",
    },
  },
});
