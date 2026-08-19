/**
 * Rooms registry (A2, PLAN.md): named message channels beside the
 * orchestrator chat. `#general` stays the RPC session's chat stream; all
 * other rooms are fed by watcher agents through `POST /api/rooms/:id/message`
 * and broadcast as `room_message` events.
 *
 * Logs are bounded per room (MAX_ROOM_MESSAGES) so long-running watcher
 * streams cannot grow the bridge's memory footprint.
 */

export interface RoomInfo {
	readonly id: string;
	readonly topic: string;
}

export interface RoomMessage {
	readonly id: string;
	readonly room: string;
	readonly from: string;
	readonly text: string;
	readonly ts: string;
}

export const MAX_ROOM_MESSAGES = 200;

/** Plan defaults; extra rooms can be registered at runtime via POST. */
export const DEFAULT_ROOMS: readonly RoomInfo[] = [
	{ id: "general", topic: "orchestrator chat" },
	{ id: "alerts", topic: "breaches and urgent watcher flags" },
	{ id: "risk-management", topic: "risk watcher output" },
	{ id: "research", topic: "research watcher and pipeline results" },
	{ id: "system-updates", topic: "bridge, daemon, and kernel notices" },
];

const ROOM_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidRoomId(id: string): boolean {
	return ROOM_ID_RE.test(id);
}

export class RoomsRegistry {
	private readonly rooms = new Map<string, RoomInfo>();
	private readonly logs = new Map<string, RoomMessage[]>();
	private seq = 0;

	constructor(defaults: readonly RoomInfo[] = DEFAULT_ROOMS) {
		for (const room of defaults) {
			this.rooms.set(room.id, room);
			this.logs.set(room.id, []);
		}
	}

	list(): RoomInfo[] {
		return [...this.rooms.values()];
	}

	has(id: string): boolean {
		return this.rooms.has(id);
	}

	history(id: string): RoomMessage[] {
		return this.logs.get(id) ?? [];
	}

	/**
	 * Append a message to a room, creating the room on first use when the id
	 * is valid. Returns the stored message, or null for invalid ids/text.
	 */
	post(room: string, from: string, text: string): RoomMessage | null {
		const trimmedFrom = from.trim().slice(0, 64);
		const trimmedText = text.trim().slice(0, 4000);
		if (!trimmedFrom || !trimmedText || !isValidRoomId(room)) {
			return null;
		}
		if (!this.rooms.has(room)) {
			this.rooms.set(room, { id: room, topic: "" });
			this.logs.set(room, []);
		}
		const message: RoomMessage = {
			id: `rm-${++this.seq}`,
			room,
			from: trimmedFrom,
			text: trimmedText,
			ts: new Date().toISOString(),
		};
		const log = this.logs.get(room) ?? [];
		log.push(message);
		if (log.length > MAX_ROOM_MESSAGES) {
			log.splice(0, log.length - MAX_ROOM_MESSAGES);
		}
		this.logs.set(room, log);
		return message;
	}
}
