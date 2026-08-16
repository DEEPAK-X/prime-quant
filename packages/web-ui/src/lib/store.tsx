/**
 * React context wrapping the quant socket so every component reads typed state
 * slices without prop drilling. The provider mounts once (in App) and owns the
 * single useQuantSocket instance for the whole tree.
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuantSocket, type QuantSocket } from "./ws";

const QuantStoreContext = createContext<QuantSocket | null>(null);

export interface QuantStoreProviderProps {
	readonly children: ReactNode;
}

export function QuantStoreProvider({ children }: QuantStoreProviderProps) {
	const socket = useQuantSocket();
	const value = useMemo<QuantSocket>(() => socket, [socket]);
	return <QuantStoreContext.Provider value={value}>{children}</QuantStoreContext.Provider>;
}

/**
 * Read the quant store. Must be called inside <QuantStoreProvider>; throws
 * explicitly (not a silent null) so a mis-wired tree fails fast in dev.
 */
export function useQuantStore(): QuantSocket {
	const value = useContext(QuantStoreContext);
	if (value === null) {
		throw new Error("useQuantStore must be used within a QuantStoreProvider");
	}
	return value;
}
