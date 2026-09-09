import express from 'express';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
const port = Number(process.env.PORT) || 3001;
const rooms = new Map();
const connectedUsers = new Map();
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: { origin: true, credentials: true },
});
app.get('/health', (_request, response) => {
    response.json({
        status: 'ok',
        connectedUsers: connectedUsers.size,
        activeRooms: rooms.size,
    });
});
const getSnapshot = (room) => ({
    id: room.id,
    users: [...room.users.values()],
});
const normaliseRoomId = (roomId) => roomId?.trim().toLowerCase();
const getUserColor = (socketId) => {
    const colors = ['#b45b48', '#7d9b71', '#6c8790', '#a98eaf', '#d39d45', '#8d7466'];
    let hash = 0;
    for (const character of socketId)
        hash = (hash * 31 + character.charCodeAt(0)) | 0;
    return colors[Math.abs(hash) % colors.length];
};
const getUserName = (socket, requestedName) => {
    const name = requestedName?.trim() || connectedUsers.get(socket.id)?.name;
    return name || `Guest-${socket.id.slice(0, 5)}`;
};
const broadcastUsers = (room) => {
    io.to(room.id).emit('room-users', getSnapshot(room));
};
const leaveCurrentRoom = async (socket) => {
    const roomId = socket.data.roomId;
    if (!roomId)
        return;
    const room = rooms.get(roomId);
    socket.data.roomId = undefined;
    await socket.leave(roomId);
    if (!room)
        return;
    room.users.delete(socket.id);
    if (room.users.size === 0) {
        rooms.delete(roomId);
    }
    else {
        broadcastUsers(room);
    }
};
const joinRoom = async (socket, room, name) => {
    await leaveCurrentRoom(socket);
    const user = { id: socket.id, name, color: getUserColor(socket.id) };
    room.users.set(socket.id, user);
    connectedUsers.set(socket.id, user);
    socket.data.roomId = room.id;
    await socket.join(room.id);
    broadcastUsers(room);
    return getSnapshot(room);
};
io.on('connection', (socket) => {
    const user = { id: socket.id, name: getUserName(socket), color: getUserColor(socket.id) };
    connectedUsers.set(socket.id, user);
    socket.on('create-room', async (payload, callback) => {
        const roomId = normaliseRoomId(payload.roomId) || randomUUID().slice(0, 8);
        if (rooms.has(roomId)) {
            callback({ ok: false, error: 'That room already exists.' });
            return;
        }
        const room = { id: roomId, users: new Map() };
        rooms.set(roomId, room);
        const snapshot = await joinRoom(socket, room, getUserName(socket, payload.name));
        callback({ ok: true, room: snapshot });
    });
    socket.on('join-room', async (payload, callback) => {
        const roomId = normaliseRoomId(payload.roomId);
        const room = roomId ? rooms.get(roomId) : undefined;
        if (!room) {
            callback({ ok: false, error: 'Room not found.' });
            return;
        }
        const snapshot = await joinRoom(socket, room, getUserName(socket, payload.name));
        callback({ ok: true, room: snapshot });
    });
    socket.on('leave-room', async (callback) => {
        const roomId = socket.data.roomId;
        await leaveCurrentRoom(socket);
        callback({ ok: true, room: { id: roomId || '', users: [] } });
    });
    socket.on('draw-batch', (batch) => {
        const roomId = socket.data.roomId;
        if (!roomId || batch.points.length === 0)
            return;
        socket.to(roomId).emit('draw-batch', batch);
    });
    socket.on('canvas-operation', (operation) => {
        const roomId = socket.data.roomId;
        if (!roomId)
            return;
        socket.to(roomId).emit('canvas-operation', operation);
    });
    socket.on('cursor-move', (position) => {
        const roomId = socket.data.roomId;
        const user = roomId ? rooms.get(roomId)?.users.get(socket.id) : undefined;
        if (!roomId || !user)
            return;
        socket.to(roomId).emit('cursor-update', { ...position, ...user });
    });
    socket.on('color-change', (color) => {
        const roomId = socket.data.roomId;
        const user = roomId ? rooms.get(roomId)?.users.get(socket.id) : undefined;
        if (!roomId || !user || !/^#[0-9a-f]{6}$/i.test(color))
            return;
        user.color = color.toUpperCase();
        const room = rooms.get(roomId);
        if (room)
            broadcastUsers(room);
    });
    socket.on('disconnect', async () => {
        await leaveCurrentRoom(socket);
        connectedUsers.delete(socket.id);
    });
});
httpServer.listen(port, () => {
    console.log(`CollabDraw server listening on http://localhost:${port}`);
});
