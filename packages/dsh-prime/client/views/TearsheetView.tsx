/**
 * prime/tearsheet renderer: sandboxed iframe (allow-same-origin only — no
 * allow-scripts, matching the native GUI), reload, open-in-browser.
 * The iframe src is the host-served /prime-reports/ URL; nothing is fetched
 * in tests (asserted via static markup).
 */

import { useState } from "react";
import type { PrimeTearsheetRecord } from "../nodes/tearsheet.js";

const COLOR_BORDER = "#30363d";
const COLOR_DIM = "#8b949e";
const COLOR_BG = "#0d1117";
const COLOR_ACCENT = "#58a6ff";

export interface TearsheetViewProps {
	readonly tearsheet: PrimeTearsheetRecord;
}

export function TearsheetView({ tearsheet }: TearsheetViewProps) {
	const [reloadKey, setReloadKey] = useState(0);
	return (
		<div style={{ display: "flex", flexDirection: "column", maxWidth: 720 }}>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					justifyContent: "space-between",
					gap: 8,
					border: `1px solid ${COLOR_BORDER}`,
					borderBottom: "none",
					padding: "3px 8px",
					background: COLOR_BG,
				}}
			>
				<span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 10, color: COLOR_DIM }}>
					{tearsheet.name}
				</span>
				<span style={{ display: "flex", flexShrink: 0, alignItems: "center", gap: 8 }}>
					<button
						type="button"
						onClick={() => setReloadKey((key) => key + 1)}
						aria-label="Reload tearsheet"
						style={{ background: "transparent", border: "none", padding: 0, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: COLOR_ACCENT, cursor: "pointer" }}
					>
						reload
					</button>
					<a
						href={tearsheet.url}
						target="_blank"
						rel="noopener noreferrer"
						aria-label="Open tearsheet in a new browser tab"
						style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: "0.08em", color: COLOR_ACCENT }}
					>
						open ↗
					</a>
				</span>
			</div>
			<iframe
				key={reloadKey}
				src={tearsheet.url}
				sandbox="allow-same-origin"
				title={`tearsheet ${tearsheet.name}`}
				style={{ width: "100%", height: 360, border: `1px solid ${COLOR_BORDER}`, background: COLOR_BG }}
			/>
		</div>
	);
}
