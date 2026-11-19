import dgram from "node:dgram";
import net from "node:net";

const HEADER_BYTES = 28;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_TCP_BUFFERED_BYTES = 1024 * 1024;
const MAX_SOCKETS = 64;
const UDP_PORTS = new Set([9295, 9296, 9297, 9302]);
const TYPES = Object.freeze({
	SOCKET: 1, CLOSE: 2, BIND: 3, CONNECT: 4, SEND: 5, SENDTO: 6,
	SETSOCKOPT: 7, GETSOCKNAME: 8, GETADDRINFO: 9, SHUTDOWN: 10,
	REPLY: 128, PUSH_DATA: 129, PUSH_CONNECTED: 130, PUSH_CLOSED: 131, PUSH_ERROR: 132
});

function isPrivateIpv4(address) {
	if (net.isIP(address) !== 4) return false;
	const [a, b] = address.split(".").map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function isConsoleIpv4(address) {
	return isPrivateIpv4(address);
}

function readPacket(buffer, requestOnly) {
	if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES || buffer.length > MAX_MESSAGE_BYTES) return null;
	const length = buffer.readUInt32LE(24);
	if (length > MAX_MESSAGE_BYTES - HEADER_BYTES || buffer.length !== HEADER_BYTES + length) return null;
	const type = buffer.readUInt8(0);
	if (requestOnly ? type < TYPES.SOCKET || type > TYPES.SHUTDOWN : type < TYPES.SOCKET || type > TYPES.PUSH_ERROR) return null;
	if (requestOnly && ![TYPES.SEND, TYPES.SENDTO, TYPES.GETADDRINFO].includes(type) && length !== 0) return null;
	if (requestOnly && type === TYPES.GETADDRINFO && (length < 1 || length > 64 || buffer[HEADER_BYTES + length - 1] !== 0)) return null;
	return {
		type, id: buffer.readUInt32LE(4), fd: buffer.readInt32LE(8),
		a: buffer.readInt32LE(12), b: buffer.readInt32LE(16), c: buffer.readInt32LE(20),
		length, payload: buffer.subarray(HEADER_BYTES)
	};
}

function readHeader(buffer) {
	return readPacket(buffer, true);
}

function encode(type, id, fd, a = 0, b = 0, c = 0, payload = null) {
	const body = payload || Buffer.alloc(0);
	const buffer = Buffer.alloc(HEADER_BYTES + body.length);
	buffer.writeUInt8(type, 0);
	buffer.writeUInt32LE(id >>> 0, 4);
	buffer.writeInt32LE(fd, 8);
	buffer.writeUInt32LE(a >>> 0, 12);
	buffer.writeUInt32LE(b >>> 0, 16);
	buffer.writeUInt32LE(c >>> 0, 20);
	buffer.writeUInt32LE(body.length, 24);
	body.copy(buffer, HEADER_BYTES);
	return buffer;
}

function intToIpv4(value) {
	const number = value >>> 0;
	return `${number & 255}.${(number >>> 8) & 255}.${(number >>> 16) & 255}.${(number >>> 24) & 255}`;
}

function ipv4ToInt(address) {
	const octets = address.split(".").map(Number);
	return (octets[0] | (octets[1] << 8) | (octets[2] << 16) | (octets[3] << 24)) >>> 0;
}

export function createChiakiRelay({ consoleIp, send, connectTimeoutMs = 5000 } = {}) {
	if (!isPrivateIpv4(consoleIp)) throw new TypeError("A configured private IPv4 console address is required");
	if (typeof send !== "function") throw new TypeError("A relay output callback is required");

	const sockets = new Map();
	let closed = false;
	const reply = (header, result, error = 0, extra = 0, payload = null) => {
		if (header.id) send(encode(TYPES.REPLY, header.id, header.fd, result, error, extra, payload));
	};
	const push = (type, fd, port = 0, address = 0, payload = null) => {
		send(encode(type, 0, fd, 0, port, address, payload));
	};
	const pushCurrent = (record, type, fd, port = 0, address = 0, payload = null) => {
		if (!closed && sockets.get(fd) === record) push(type, fd, port, address, payload);
	};
	const replyCurrent = (record, header, result, error = 0, extra = 0, payload = null) => {
		if (!closed && sockets.get(header.fd) === record) reply(header, result, error, extra, payload);
	};
	const allowed = (address, port, kind) => address === consoleIp &&
		(kind === 1 ? port === 9295 : UDP_PORTS.has(port));
	const closeSocket = (record) => {
		clearTimeout(record.connectTimer);
		try { record.udp?.close(); } catch {}
		try { record.tcp?.destroy(); } catch {}
	};
	const fail = (header, error = 13) => reply(header, -1, error);

	function validHeader(header) {
		return header && header.fd >= 0 && header.fd <= 65535 && header.id <= 0xffffffff;
	}

	function installUdp(fd, record) {
		record.udp = dgram.createSocket("udp4");
		record.udp.on("message", (payload, remote) => {
			if (remote.address === consoleIp && allowed(remote.address, remote.port, 2))
				pushCurrent(record, TYPES.PUSH_DATA, fd, remote.port, ipv4ToInt(remote.address), payload);
		});
		record.udp.on("error", () => pushCurrent(record, TYPES.PUSH_ERROR, fd));
	}

	async function dispatch(header) {
		const { type, fd, id, a, b, c, payload } = header;
		let record = sockets.get(fd);
		if (type === TYPES.SOCKET) {
			if (b !== 1 && b !== 2) return fail(header, 24);
			if (!record && sockets.size >= MAX_SOCKETS) return fail(header, 24);
			if (record) closeSocket(record);
			record = { kind: b, connected: false, remotePort: 0, remoteIp: "", tcp: null, udp: null, bound: false };
			sockets.set(fd, record);
			if (b === 2) installUdp(fd, record);
			reply(header, 0);
			return;
		}
		if (type === TYPES.CLOSE) {
			if (record) { closeSocket(record); sockets.delete(fd); }
			reply(header, 0);
			return;
		}
		if (type === TYPES.GETADDRINFO) {
			const host = payload.toString("utf8").replace(/\0+$/, "");
			if (host !== consoleIp) return fail(header, 2);
			const ip = Buffer.alloc(4);
			ip.writeUInt32LE(ipv4ToInt(consoleIp), 0);
			reply(header, ipv4ToInt(consoleIp), 0, 0, ip);
			return;
		}
		if (type === TYPES.CONNECT) {
			const address = intToIpv4(c);
			if (!allowed(address, b, record?.kind ?? 2)) return fail(header);
			if (!record) {
				if (sockets.size >= MAX_SOCKETS) return fail(header, 24);
				record = { kind: 2, connected: false, remotePort: 0, remoteIp: "", tcp: null, udp: null, bound: false };
				installUdp(fd, record);
				sockets.set(fd, record);
			}
			record.remotePort = b;
			record.remoteIp = address;
			if (record.udp) { reply(header, 0); return; }
			if (record.kind !== 1 || record.tcp) return fail(header, 22);
			const tcp = net.connect({ host: consoleIp, port: b, family: 4 });
			record.tcp = tcp;
			let settled = false;
			record.connectTimer = setTimeout(() => tcp.destroy(new Error("connect timeout")), connectTimeoutMs);
			tcp.on("connect", () => {
				clearTimeout(record.connectTimer);
				if (sockets.get(fd) !== record || closed) return;
				record.connected = true;
				pushCurrent(record, TYPES.PUSH_CONNECTED, fd);
				if (!settled) { settled = true; replyCurrent(record, header, 0); }
			});
			tcp.on("data", (chunk) => pushCurrent(record, TYPES.PUSH_DATA, fd, b, ipv4ToInt(consoleIp), chunk));
			tcp.on("close", () => pushCurrent(record, TYPES.PUSH_CLOSED, fd));
			tcp.on("error", () => {
				clearTimeout(record.connectTimer);
				if (sockets.get(fd) !== record || closed) return;
				if (!settled) { settled = true; replyCurrent(record, header, -1, 111); }
				pushCurrent(record, TYPES.PUSH_ERROR, fd);
			});
			return;
		}
		if (!record) return fail(header, 9);
		if (type === TYPES.SEND || type === TYPES.SENDTO) {
			const address = c ? intToIpv4(c) : record.remoteIp;
			const port = b || record.remotePort;
			if (!allowed(address, port, record.kind)) return fail(header);
			if (record.udp) {
				record.udp.send(payload, port, consoleIp, (error) => {
					if (error) replyCurrent(record, header, -1, 5);
					else replyCurrent(record, header, payload.length);
				});
				return;
			}
			if (!record.tcp || !record.connected) return fail(header, 107);
			if (record.tcp.writableLength + payload.length > MAX_TCP_BUFFERED_BYTES) {
				record.tcp.destroy();
				return replyCurrent(record, header, -1, 105);
			}
			record.tcp.write(payload, (error) => error
				? replyCurrent(record, header, -1, 5)
				: replyCurrent(record, header, payload.length));
			return;
		}
		if (type === TYPES.BIND) {
			if (!record.udp || record.bound) return reply(header, 0);
			record.udp.bind(0, "0.0.0.0", () => {
				if (sockets.get(fd) !== record || closed) return;
				record.bound = true;
				replyCurrent(record, header, 0);
			});
			record.udp.once("error", () => replyCurrent(record, header, -1, 98));
			return;
		}
		if (type === TYPES.GETSOCKNAME) {
			let port = 0;
			try { port = record.udp?.address()?.port || record.tcp?.localPort || 0; } catch {}
			reply(header, port, 0, 0);
			return;
		}
		if (type === TYPES.SHUTDOWN) {
			record.tcp?.end();
			reply(header, 0);
			return;
		}
		if (type === TYPES.SETSOCKOPT) return reply(header, 0);
		return fail(header, 22);
	}

	return {
		async handle(message) {
			if (closed) return;
			const header = readHeader(message);
			if (!validHeader(header)) return;
			try { await dispatch(header); } catch { fail(header, 5); }
		},
		closeAll() {
			if (closed) return;
			closed = true;
			for (const record of sockets.values()) closeSocket(record);
			sockets.clear();
		},
	};
}

export const chiakiRelayProtocol = Object.freeze({ HEADER_BYTES, MAX_MESSAGE_BYTES, MAX_SOCKETS, UDP_PORTS, TYPES, readHeader, readPacket: (buffer) => readPacket(buffer, false), encode, isPrivateIpv4, isConsoleIpv4 });
