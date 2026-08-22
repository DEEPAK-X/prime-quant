/**
 * DSH client settings entry (`@prime-quant/dsh-prime/client-settings`,
 * cordis row `prime-client-settings`). Contributes the Prime Agent card to
 * the configurable-plugins tab, keyed by the `prime-agent` namespace.
 *
 * Display-only against `GET /prime-status` (host-glue): no POST reprobe in
 * v1, no daemon call, no Prime spawn. If the pinned DSH grows a dedicated
 * settings-plugin API, only this file changes.
 */

import { createElement, type ReactElement } from "react";
import type { ClientContext } from "./dsh-client.js";
import { SettingsView } from "./views/SettingsView.js";

const SETTINGS_PLUGIN_ITEM_SLOT = "settings.plugin.item";
export const PRIME_SETTINGS_NAMESPACE = "prime-agent";

const primeSettingsCard = (): ReactElement => createElement(SettingsView);

export function apply(ctx: ClientContext): void {
	ctx.slots.inject(SETTINGS_PLUGIN_ITEM_SLOT, () =>
		ctx.slots.register({ name: SETTINGS_PLUGIN_ITEM_SLOT, key: PRIME_SETTINGS_NAMESPACE }, primeSettingsCard),
	);
}
