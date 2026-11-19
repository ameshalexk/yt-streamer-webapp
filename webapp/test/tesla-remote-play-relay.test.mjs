import test from "node:test";
import assert from "node:assert/strict";
import {
	createChiakiRelay,
	isConsoleIpv4,
	chiakiRelayProtocol as protocol,
} from "../src/lib/tesla-remote-play-relay.mjs";

function request(type, { id = 1, fd = 3, a = 0, b = 0, c = 0, payload = null } = {}) {
	return protocol.encode(type, id, fd, a, b, c, payload);
}

test("console address accepts only RFC1918 IPv4 literals", () => {
	for (const address of ["10.0.0.2", "172.16.0.2", "172.31.255.254", "192.168.1.20"]) {
		assert.equal(isConsoleIpv4(address), true, address);
	}
	for (const address of ["172.15.0.1", "172.32.0.1", "192.169.1.1", "127.0.0.1", "169.254.1.1", "8.8.8.8", "::1", "192.168.1.999"]) {
		assert.equal(isConsoleIpv4(address), false, address);
	}
	assert.throws(() => createChiakiRelay({ consoleIp: "127.0.0.1", send() {} }), /private IPv4/);
});

test("protocol parser requires a complete bounded request and known operation", () => {
	const valid = request(protocol.TYPES.SOCKET, { b: 1 });
	assert.equal(protocol.readHeader(valid).type, protocol.TYPES.SOCKET);
	assert.equal(protocol.readHeader(valid.subarray(0, 27)), null);
	assert.equal(protocol.readHeader(Buffer.concat([valid, Buffer.from([0])])), null);

	const oversizedLength = Buffer.from(valid);
	oversizedLength.writeUInt32LE(protocol.MAX_MESSAGE_BYTES, 24);
	assert.equal(protocol.readHeader(oversizedLength), null);

	const unknown = Buffer.from(valid);
	unknown.writeUInt8(127, 0);
	assert.equal(protocol.readHeader(unknown), null);

	const illegalBody = request(protocol.TYPES.CLOSE, { payload: Buffer.from("unexpected") });
	assert.equal(protocol.readHeader(illegalBody), null);
});

test("relay rejects unconfigured destinations before opening sockets", async () => {
	const output = [];
	const relay = createChiakiRelay({ consoleIp: "192.168.1.20", send: (message) => output.push(message) });
	const externalIpAsInt = 0x08080808;
	await relay.handle(request(protocol.TYPES.CONNECT, { b: 443, c: externalIpAsInt }));
	const response = protocol.readPacket(output[0]);
	assert.equal(response.type, protocol.TYPES.REPLY);
	assert.equal(response.a, -1);
	assert.equal(response.b, 13);
	assert.equal(output.length, 1);
	relay.closeAll();
});

test("relay returns only the configured console from getaddrinfo", async () => {
	const output = [];
	const relay = createChiakiRelay({ consoleIp: "192.168.1.20", send: (message) => output.push(message) });
	const permitted = request(protocol.TYPES.GETADDRINFO, { payload: Buffer.from("192.168.1.20\0") });
	await relay.handle(permitted);
	assert.deepEqual([...protocol.readPacket(output[0]).payload], [192, 168, 1, 20]);

	const denied = request(protocol.TYPES.GETADDRINFO, { payload: Buffer.from("192.168.1.21\0") });
	await relay.handle(denied);
	assert.equal(protocol.readPacket(output[1]).a, -1);
	relay.closeAll();
});

test("UDP bind state is cleared when a descriptor is closed and reused", async () => {
	const output = [];
	const relay = createChiakiRelay({ consoleIp: "192.168.1.20", send: (message) => output.push(message) });
	const replyFor = (id) => output.map((message) => protocol.readPacket(message)).find((packet) => packet?.type === protocol.TYPES.REPLY && packet.id === id);
	const waitForReply = async (id) => {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const packet = replyFor(id);
			if (packet) return packet;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		throw new Error(`No reply for request ${id}`);
	};

	await relay.handle(request(protocol.TYPES.SOCKET, { id: 1, fd: 5, b: 2 }));
	await relay.handle(request(protocol.TYPES.BIND, { id: 2, fd: 5 }));
	await waitForReply(2);
	await relay.handle(request(protocol.TYPES.GETSOCKNAME, { id: 3, fd: 5 }));
	const firstPort = (await waitForReply(3)).a;
	assert.ok(firstPort > 0);

	await relay.handle(request(protocol.TYPES.CLOSE, { id: 4, fd: 5 }));
	await relay.handle(request(protocol.TYPES.SOCKET, { id: 5, fd: 5, b: 2 }));
	await relay.handle(request(protocol.TYPES.BIND, { id: 6, fd: 5 }));
	await waitForReply(6);
	await relay.handle(request(protocol.TYPES.GETSOCKNAME, { id: 7, fd: 5 }));
	const secondPort = (await waitForReply(7)).a;
	assert.ok(secondPort > 0);
	assert.notEqual(secondPort, firstPort);
	relay.closeAll();
});

test("replacement at the descriptor limit does not exceed the limit", async () => {
	const output = [];
	const relay = createChiakiRelay({ consoleIp: "192.168.1.20", send: (message) => output.push(message) });
	for (let fd = 0; fd < protocol.MAX_SOCKETS; fd += 1) {
		await relay.handle(request(protocol.TYPES.SOCKET, { id: fd + 1, fd, b: 1 }));
	}
	await relay.handle(request(protocol.TYPES.SOCKET, { id: 100, fd: 0, b: 2 }));
	const replacement = output.map((message) => protocol.readPacket(message)).find((packet) => packet?.id === 100);
	assert.equal(replacement?.a, 0);
	await relay.handle(request(protocol.TYPES.SOCKET, { id: 101, fd: 100, b: 1 }));
	const overflow = output.map((message) => protocol.readPacket(message)).find((packet) => packet?.id === 101);
	assert.equal(overflow?.a, -1);
	assert.equal(overflow?.b, 24);
	relay.closeAll();
});
