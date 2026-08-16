import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const BACKEND = "http://localhost:3001";

// The GUI is a thin client: /api JSON endpoints and the /ws event stream are
// both proxied to the PrimeQuant backend (daemon) on localhost:3001 in dev.
// In production the backend is expected to serve the same paths same-origin.
export default defineConfig({
	plugins: [react(), tailwindcss()],
	server: {
		port: 5173,
		proxy: {
			"/api": {
				target: BACKEND,
				changeOrigin: true,
			},
			"/reports": {
				target: BACKEND,
				changeOrigin: true,
			},
			"/artifacts": {
				target: BACKEND,
				changeOrigin: true,
			},
			"/ws": {
				target: BACKEND.replace("http", "ws"),
				ws: true,
			},
		},
	},
});
