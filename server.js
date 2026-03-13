// ============================================
// RACING GAME — WebSocket Server
// ============================================
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const TICK_RATE = 20; // обновлений в секунду
const MAX_PLAYERS_PER_ROOM = 6;
const COUNTDOWN_SECONDS = 5;

// ============================================
// Хранилище данных
// ============================================
const rooms = new Map();       // roomId -> Room
const clients = new Map();     // ws -> PlayerData

let nextRoomId = 1;
let nextPlayerId = 1;

// ============================================
// Класс комнаты
// ============================================
class Room {
    constructor(id, name, trackId = 0) {
        this.id = id;
        this.name = name;
        this.trackId = trackId;
        this.maxPlayers = MAX_PLAYERS_PER_ROOM;
        this.players = new Map(); // playerId -> PlayerData
        this.state = 'waiting';   // waiting | countdown | racing | finished
        this.raceStartTime = 0;
        this.laps = 3;
        this.results = [];
    }

    get playerCount() {
        return this.players.size;
    }

    isFull() {
        return this.playerCount >= this.maxPlayers;
    }

    allReady() {
        if (this.playerCount < 1) return false;
        for (const p of this.players.values()) {
            if (!p.ready) return false;
        }
        return true;
    }

    getInfo() {
        return {
            id: this.id,
            name: this.name,
            players: this.playerCount,
            maxPlayers: this.maxPlayers,
            state: this.state,
            trackId: this.trackId
        };
    }

    getPlayerList() {
        const list = [];
        for (const p of this.players.values()) {
            list.push({
                id: p.id,
                name: p.name,
                carId: p.carId,
                ready: p.ready,
                lap: p.lap,
                position: p.racePosition,
                bestLap: p.bestLapTime,
                finished: p.finished
            });
        }
        return list;
    }
}

// ============================================
// WebSocket Сервер
// ============================================
const wss = new WebSocket.Server({ port: PORT });

console.log(`🏎️  Racing Game Server запущен на порту ${PORT}`);
console.log(`   Tick rate: ${TICK_RATE} Hz`);
console.log(`   Макс. игроков в комнате: ${MAX_PLAYERS_PER_ROOM}`);

wss.on('connection', (ws) => {
    const playerId = nextPlayerId++;
    const playerData = {
        id: playerId,
        name: `Player${playerId}`,
        ws: ws,
        roomId: null,
        carId: 0,
        ready: false,
        // Позиция в игре
        posX: 0, posY: 0, posZ: 0,
        rotY: 0,
        speed: 0,
        steering: 0,
        // Гоночные данные
        lap: 0,
        checkpoint: 0,
        racePosition: 0,
        lapStartTime: 0,
        bestLapTime: 999999,
        totalTime: 0,
        finished: false,
        finishTime: 0
    };

    clients.set(ws, playerData);
    console.log(`✅ Игрок ${playerId} подключился (всего: ${clients.size})`);

    send(ws, { type: 'welcome', playerId: playerId });

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            handleMessage(ws, playerData, msg);
        } catch (e) {
            console.error('Ошибка парсинга:', e.message);
        }
    });

    ws.on('close', () => {
        handleDisconnect(ws, playerData);
        clients.delete(ws);
        console.log(`❌ Игрок ${playerData.id} отключился (всего: ${clients.size})`);
    });

    ws.on('error', (err) => {
        console.error(`Ошибка WS игрока ${playerData.id}:`, err.message);
    });
});

// ============================================
// Обработка сообщений
// ============================================
function handleMessage(ws, player, msg) {
    switch (msg.type) {
        case 'set_name':
            player.name = (msg.name || 'Player').substring(0, 20);
            send(ws, { type: 'name_set', name: player.name });
            break;

        case 'get_rooms':
            sendRoomList(ws);
            break;

        case 'create_room':
            createRoom(ws, player, msg);
            break;

        case 'join_room':
            joinRoom(ws, player, msg.roomId);
            break;

        case 'leave_room':
            leaveRoom(ws, player);
            break;

        case 'select_car':
            selectCar(ws, player, msg.carId);
            break;

        case 'ready':
            setReady(ws, player, msg.ready);
            break;

        case 'player_update':
            updatePlayerPosition(player, msg);
            break;

        case 'checkpoint':
            handleCheckpoint(player, msg.checkpointId);
            break;

        case 'lap_complete':
            handleLapComplete(player, msg.lapTime);
            break;

        case 'race_finished':
            handleRaceFinished(player, msg.totalTime);
            break;

        case 'chat':
            handleChat(player, msg.text);
            break;

        default:
            console.log(`Неизвестный тип сообщения: ${msg.type}`);
    }
}

// ============================================
// Управление комнатами
// ============================================
function createRoom(ws, player, msg) {
    if (player.roomId !== null) {
        leaveRoom(ws, player);
    }

    const roomId = nextRoomId++;
    const roomName = (msg.name || `Комната ${roomId}`).substring(0, 30);
    const trackId = msg.trackId || 0;

    const room = new Room(roomId, roomName, trackId);
    rooms.set(roomId, room);

    joinRoom(ws, player, roomId);
    console.log(`🏠 Комната "${roomName}" создана (ID: ${roomId})`);
}

function joinRoom(ws, player, roomId) {
    const room = rooms.get(roomId);
    if (!room) {
        send(ws, { type: 'error', message: 'Комната не найдена' });
        return;
    }
    if (room.isFull()) {
        send(ws, { type: 'error', message: 'Комната заполнена' });
        return;
    }
    if (room.state !== 'waiting') {
        send(ws, { type: 'error', message: 'Гонка уже идёт' });
        return;
    }

    if (player.roomId !== null) {
        leaveRoom(ws, player);
    }

    player.roomId = roomId;
    player.ready = false;
    player.lap = 0;
    player.checkpoint = 0;
    player.finished = false;
    room.players.set(player.id, player);

    send(ws, {
        type: 'room_joined',
        roomId: roomId,
        roomName: room.name,
        trackId: room.trackId
    });

    broadcastToRoom(room, {
        type: 'player_joined',
        playerId: player.id,
        playerName: player.name,
        players: room.getPlayerList()
    });

    console.log(`  → Игрок ${player.name} зашёл в комнату "${room.name}"`);
}

function leaveRoom(ws, player) {
    if (player.roomId === null) return;

    const room = rooms.get(player.roomId);
    if (room) {
        room.players.delete(player.id);

        broadcastToRoom(room, {
            type: 'player_left',
            playerId: player.id,
            playerName: player.name,
            players: room.getPlayerList()
        });

        console.log(`  ← Игрок ${player.name} вышел из комнаты "${room.name}"`);

        // Удалить пустую комнату
        if (room.playerCount === 0) {
            rooms.delete(room.id);
            console.log(`🗑️  Комната "${room.name}" удалена (пустая)`);
        }
    }

    player.roomId = null;
    player.ready = false;
    send(ws, { type: 'room_left' });
}

function selectCar(ws, player, carId) {
    player.carId = carId || 0;
    send(ws, { type: 'car_selected', carId: player.carId });

    const room = rooms.get(player.roomId);
    if (room) {
        broadcastToRoom(room, {
            type: 'player_car_changed',
            playerId: player.id,
            carId: player.carId,
            players: room.getPlayerList()
        });
    }
}

function setReady(ws, player, isReady) {
    player.ready = isReady;

    const room = rooms.get(player.roomId);
    if (!room) return;

    broadcastToRoom(room, {
        type: 'player_ready_changed',
        playerId: player.id,
        ready: isReady,
        players: room.getPlayerList()
    });

    // Проверить, все ли готовы
    if (room.allReady() && room.playerCount >= 1) {
        startCountdown(room);
    }
}

// ============================================
// Гоночная логика
// ============================================
function startCountdown(room) {
    room.state = 'countdown';
    let countdown = COUNTDOWN_SECONDS;

    broadcastToRoom(room, {
        type: 'race_countdown_start',
        seconds: countdown,
        trackId: room.trackId
    });

    const interval = setInterval(() => {
        countdown--;
        if (countdown > 0) {
            broadcastToRoom(room, {
                type: 'race_countdown',
                seconds: countdown
            });
        } else {
            clearInterval(interval);
            startRace(room);
        }
    }, 1000);
}

function startRace(room) {
    room.state = 'racing';
    room.raceStartTime = Date.now();
    room.results = [];

    // Сбросить данные игроков
    let startPos = 0;
    for (const p of room.players.values()) {
        p.lap = 0;
        p.checkpoint = 0;
        p.finished = false;
        p.bestLapTime = 999999;
        p.totalTime = 0;
        p.lapStartTime = Date.now();
        p.racePosition = startPos;
        startPos++;
    }

    broadcastToRoom(room, {
        type: 'race_start',
        timestamp: room.raceStartTime,
        laps: room.laps
    });

    console.log(`🏁 Гонка началась в комнате "${room.name}"!`);
}

function handleCheckpoint(player, checkpointId) {
    player.checkpoint = checkpointId;
    const room = rooms.get(player.roomId);
    if (room) {
        updateRacePositions(room);
    }
}

function handleLapComplete(player, lapTime) {
    player.lap++;
    if (lapTime < player.bestLapTime) {
        player.bestLapTime = lapTime;
    }
    player.lapStartTime = Date.now();

    const room = rooms.get(player.roomId);
    if (!room) return;

    broadcastToRoom(room, {
        type: 'player_lap',
        playerId: player.id,
        lap: player.lap,
        lapTime: lapTime,
        bestLap: player.bestLapTime
    });

    // Проверить, финишировал ли игрок
    if (player.lap >= room.laps) {
        handleRaceFinished(player, Date.now() - room.raceStartTime);
    }

    updateRacePositions(room);
}

function handleRaceFinished(player, totalTime) {
    if (player.finished) return;

    player.finished = true;
    player.totalTime = totalTime;
    player.finishTime = Date.now();

    const room = rooms.get(player.roomId);
    if (!room) return;

    room.results.push({
        playerId: player.id,
        playerName: player.name,
        totalTime: totalTime,
        bestLap: player.bestLapTime,
        position: room.results.length + 1
    });

    broadcastToRoom(room, {
        type: 'player_finished',
        playerId: player.id,
        playerName: player.name,
        totalTime: totalTime,
        position: room.results.length,
        results: room.results
    });

    console.log(`🏆 ${player.name} финишировал ${room.results.length}-м в "${room.name}"`);

    // Все ли финишировали?
    let allFinished = true;
    for (const p of room.players.values()) {
        if (!p.finished) {
            allFinished = false;
            break;
        }
    }

    if (allFinished) {
        endRace(room);
    }
}

function endRace(room) {
    room.state = 'finished';

    broadcastToRoom(room, {
        type: 'race_end',
        results: room.results
    });

    console.log(`🏁 Гонка в комнате "${room.name}" завершена!`);

    // Через 15 секунд вернуть комнату в ожидание
    setTimeout(() => {
        if (rooms.has(room.id)) {
            room.state = 'waiting';
            for (const p of room.players.values()) {
                p.ready = false;
                p.lap = 0;
                p.checkpoint = 0;
                p.finished = false;
            }
            broadcastToRoom(room, {
                type: 'room_reset',
                players: room.getPlayerList()
            });
        }
    }, 15000);
}

function updateRacePositions(room) {
    // Сортировка: по кругам (больше = лучше), затем по чекпоинтам
    const sorted = [...room.players.values()]
        .filter(p => !p.finished)
        .sort((a, b) => {
            if (b.lap !== a.lap) return b.lap - a.lap;
            return b.checkpoint - a.checkpoint;
        });

    sorted.forEach((p, i) => {
        p.racePosition = room.results.length + i;
    });
}

// ============================================
// Синхронизация позиций
// ============================================
function updatePlayerPosition(player, msg) {
    player.posX = msg.x || 0;
    player.posY = msg.y || 0;
    player.posZ = msg.z || 0;
    player.rotY = msg.ry || 0;
    player.speed = msg.spd || 0;
    player.steering = msg.str || 0;
}

// Рассылка позиций всех игроков (игровой тик)
function gameTick() {
    for (const room of rooms.values()) {
        if (room.state !== 'racing' && room.state !== 'countdown') continue;

        const positions = [];
        for (const p of room.players.values()) {
            positions.push({
                id: p.id,
                x: p.posX,
                y: p.posY,
                z: p.posZ,
                ry: p.rotY,
                spd: p.speed,
                str: p.steering
            });
        }

        broadcastToRoom(room, {
            type: 'game_state',
            players: positions,
            time: Date.now()
        });
    }
}

setInterval(gameTick, 1000 / TICK_RATE);

// ============================================
// Чат
// ============================================
function handleChat(player, text) {
    if (!text || !player.roomId) return;
    const room = rooms.get(player.roomId);
    if (!room) return;

    broadcastToRoom(room, {
        type: 'chat',
        playerId: player.id,
        playerName: player.name,
        text: text.substring(0, 200)
    });
}

// ============================================
// Отключение
// ============================================
function handleDisconnect(ws, player) {
    leaveRoom(ws, player);
}

// ============================================
// Утилиты
// ============================================
function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function sendRoomList(ws) {
    const list = [];
    for (const room of rooms.values()) {
        list.push(room.getInfo());
    }
    send(ws, { type: 'room_list', rooms: list });
}

function broadcastToRoom(room, data) {
    const json = JSON.stringify(data);
    for (const p of room.players.values()) {
        if (p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(json);
        }
    }
}

// ============================================
// Периодическая очистка пустых комнат
// ============================================
setInterval(() => {
    for (const [id, room] of rooms) {
        if (room.playerCount === 0) {
            rooms.delete(id);
        }
    }
}, 30000);

console.log('✅ Сервер готов принимать подключения!');
