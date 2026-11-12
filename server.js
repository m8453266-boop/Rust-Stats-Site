require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const STEAM_API_KEY = process.env.STEAM_API_KEY;

if (!STEAM_API_KEY) {
    console.error('❌ STEAM_API_KEY не найден в .env');
    process.exit(1);
}

app.set('trust proxy', 1);

// Отдаём только страницу и картинку персонажа, а не весь проект
const sendPublic = file => (req, res) =>
    res.sendFile(path.join(__dirname, file), err => {
        if (err && !res.headersSent) res.status(404).end();
    });

app.get(['/', '/index.html'], sendPublic('index.html'));
app.get('/rust-character.png', sendPublic('rust-character.png'));

// ===== PWA: приложение на телефон =====
app.get('/manifest.webmanifest', sendPublic('manifest.webmanifest'));
app.get('/sw.js', sendPublic('sw.js'));
app.get('/icon-192.png', sendPublic('icon-192.png'));
app.get('/icon-512.png', sendPublic('icon-512.png'));
app.get('/icon-maskable-512.png', sendPublic('icon-maskable-512.png'));
app.get('/apple-touch-icon.png', sendPublic('apple-touch-icon.png'));


// ===== Ограничение запросов: не больше 30 в минуту с одного IP =====
const hits = new Map();
function rateLimit(max, windowMs) {
    return (req, res, next) => {
        const now = Date.now();
        const rec = hits.get(req.ip);
        if (!rec || now > rec.reset) {
            hits.set(req.ip, { count: 1, reset: now + windowMs });
            return next();
        }
        rec.count++;
        if (rec.count > max) {
            res.set('Retry-After', String(Math.ceil((rec.reset - now) / 1000)));
            return res.status(429).json({ error: 'Слишком много запросов, подожди минуту' });
        }
        next();
    };
}
setInterval(() => {
    const now = Date.now();
    for (const [ip, rec] of hits) if (now > rec.reset) hits.delete(ip);
}, 60 * 1000).unref();

// ===== Кеш ответов на 1 минуту (экономит лимит Steam API) =====
const CACHE_TTL = 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

// ===== История присутствия: сессии на серверах (Steam её не хранит) =====
// db[steamId] = { lastSearch, session: {...}|null, lastServer: {...}|null }
const DB_FILE = path.join(__dirname, 'presence-db.json');
let db = {};
try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) {}
let dbTimer = null;
function saveDb() {
    if (dbTimer) return;
    dbTimer = setTimeout(() => {
        dbTimer = null;
        fs.writeFile(DB_FILE, JSON.stringify(db), () => {});
    }, 1000);
}

// Название сервера по ip:port через список серверов Steam
async function lookupServer(addr) {
    const [ip, portStr] = String(addr).split(':');
    const port = Number(portStr) || 0;
    const info = { addr, name: null, players: null, maxPlayers: null, map: null };
    try {
        const filter = encodeURIComponent(`\\appid\\252490\\addr\\${ip}`);
        const url = `https://api.steampowered.com/IGameServersService/GetServerList/v1/?key=${STEAM_API_KEY}&filter=${filter}&limit=50`;
        const data = await (await fetch(url)).json();
        const list = data.response?.servers || [];
        const s =
            list.find(x => Number(x.gameport) === port) ||
            list.find(x => String(x.addr).endsWith(':' + port)) ||
            list.find(x => String(x.addr).endsWith(':' + (port + 1))) ||
            (list.length === 1 ? list[0] : null);
        if (s) {
            info.name = s.name;
            info.players = s.players;
            info.maxPlayers = s.max_players;
            info.map = s.map;
        }
    } catch (e) {
        console.error('Ошибка поиска сервера:', e.message);
    }
    return info;
}

// Название сервера с кешем на 5 минут
const serverCache = new Map();
async function getServerInfo(addr) {
    const hit = serverCache.get(addr);
    if (hit && Date.now() - hit.time < 5 * 60 * 1000) return hit.info;
    const info = await lookupServer(addr);
    if (serverCache.size > 500) serverCache.delete(serverCache.keys().next().value);
    serverCache.set(addr, { time: Date.now(), info });
    return info;
}

// Обновляет сессию игрока по свежим данным GetPlayerSummaries
const SESSION_GAP = 10 * 60; // сек: перерыв дольше этого = новая сессия
async function updatePresence(steamId, player, touch) {
    const now = Math.floor(Date.now() / 1000);
    const rec = db[steamId] || (db[steamId] = { lastSearch: now, session: null, lastServer: null });
    if (touch) rec.lastSearch = now;

    const inRust = String(player.gameid) === '252490';
    const addr = inRust ? player.gameserverip : null;

    if (addr) {
        const info = await getServerInfo(addr);
        const s = rec.session;
        if (s && s.addr === addr && now - s.last < SESSION_GAP) {
            Object.assign(s, { ...info, name: info.name || s.name, last: now });
        } else {
            if (s) rec.lastServer = { ...s, end: s.last };
            rec.session = { ...info, start: now, last: now };
        }
    } else if (!inRust && rec.session) {
        // игрок вышел из Rust: закрываем сессию
        rec.lastServer = { ...rec.session, end: rec.session.last };
        rec.session = null;
    }
    saveDb();
    return rec;
}

// Фоновый опрос всех, кого искали за последнюю неделю: так время на сервере считается точнее
async function pollTracked() {
    const now = Math.floor(Date.now() / 1000);
    for (const id of Object.keys(db)) {
        if (now - (db[id].lastSearch || 0) > 30 * 86400) delete db[id];
    }
    const ids = Object.keys(db)
        .filter(id => now - (db[id].lastSearch || 0) < 7 * 86400)
        .slice(0, 300);
    for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        try {
            const r = await fetch(`https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${batch.join(',')}`);
            const d = await r.json();
            for (const p of d.response?.players || []) await updatePresence(p.steamid, p, false);
        } catch (e) {
            console.error('Ошибка опроса присутствия:', e.message);
        }
    }
}
setInterval(pollTracked, 2 * 60 * 1000).unref();

app.get('/health', (req, res) => res.send('ok'));

async function resolveToSteamId(input) {
    input = input.trim();

    if (/^\d{17}$/.test(input)) return input;

    input = input
        .replace(/^https?:\/\/(www\.)?steamcommunity\.com\/id\//i, '')
        .replace(/^https?:\/\/(www\.)?steamcommunity\.com\/profiles\//i, '')
        .replace(/\/$/, '');

    if (/^\d{17}$/.test(input)) return input;

    const url = `https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${STEAM_API_KEY}&vanityurl=${encodeURIComponent(input)}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.response?.success === 1) {
        return data.response.steamid;
    }

    throw new Error('Игрок с таким ником не найден');
}

// Максимум из списка точных имён статистики
function pick(stats, names) {
    return Math.max(0, ...names.map(n => Number(stats[n]) || 0));
}

// Запасной вариант: ищем статистику по маске в названии (максимум среди совпавших)
function fuzzy(stats, include, exclude) {
    let best = 0;
    for (const [name, value] of Object.entries(stats)) {
        const n = name.toLowerCase();
        if (include.test(n) && !(exclude && exclude.test(n))) {
            best = Math.max(best, Number(value) || 0);
        }
    }
    return best;
}

async function getRustStats(steamId) {
    try {
        const url = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=252490&key=${STEAM_API_KEY}&steamid=${steamId}`;
        const res = await fetch(url);
        const data = await res.json();

        if (!data.playerstats || !data.playerstats.stats) {
            return null;
        }

        const stats = {};
        for (const s of data.playerstats.stats) {
            stats[s.name] = s.value;
        }

        const kills = stats['kill_player'] || 0;
        const deaths = stats['deaths'] || 0;
        const headshots = stats['headshot'] || 0;
        const shots = stats['bullet_fired'] || 0;

        // Ресурсы: сначала точные имена, потом поиск по маске
        const wood =
            pick(stats, ['harvest.wood', 'harvested_wood', 'harvest_wood', 'acquired_wood']) ||
            fuzzy(stats, /wood/, /wooden|woodpile/);

        const stone =
            pick(stats, ['harvest.stones', 'harvested_stones', 'harvest_stones', 'harvest.stone', 'acquired_stones']) ||
            fuzzy(stats, /stone/, /stonecutter|stone_?(hatchet|pickaxe|spear)/);

        const sulfur =
            pick(stats, ['acquired_sulfur.ore', 'harvest.sulfur_ore', 'harvest.sulfur.ore', 'acquired_sulfur', 'harvest.sulfur']) ||
            fuzzy(stats, /sulfur|sulphur/, /sulfur_?(bomb|crate)/);

        const metal =
            pick(stats, ['acquired_metal.ore', 'harvest.metal_ore', 'harvested_metal_ore']) ||
            fuzzy(stats, /metal.*ore|ore.*metal/, /hq|refined|high/);

        const hqm =
            pick(stats, ['acquired_metal.refined', 'acquired_hq.metal.ore', 'harvest.hq_metal_ore', 'acquired_hq_metal', 'harvest.hq_metal']) ||
            fuzzy(stats, /hq|refined/, /hqm_?(door|wall)/);

        // Все ресурсные статы, которые реально есть у игрока
        const resources = Object.entries(stats)
            .filter(([name, value]) => /^(harvest|harvested|acquired)/i.test(name) && Number(value) > 0)
            .map(([name, value]) => ({ name, value: Number(value) }))
            .sort((a, b) => b.value - a.value);

        let kd = '0.00';
        if (deaths > 0) {
            kd = (kills / deaths).toFixed(2);
        } else if (kills > 0) {
            kd = kills.toFixed(2);
        }

        return {
            kills,
            deaths,
            kd,
            headshots,
            shots,
            wood,
            stone,
            sulfur,
            metal,
            hqm,
            resources,
            available: true
        };
    } catch (e) {
        console.error('Ошибка получения статов:', e.message);
        return null;
    }
}

async function getPlayerData(steamId) {
    const profileRes = await fetch(
        `https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v2/?key=${STEAM_API_KEY}&steamids=${steamId}`
    );
    const profileData = await profileRes.json();
    const player = profileData.response.players[0];

    if (!player) {
        throw new Error('Игрок не найден');
    }

    let hours = null;
    let playtime2w = null;
    let lastPlayed = null;

    try {
        const gamesRes = await fetch(
            `https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/?key=${STEAM_API_KEY}&steamid=${steamId}&include_appinfo=1&include_played_free_games=1`
        );
        const gamesData = await gamesRes.json();

        if (gamesData.response?.games) {
            const rust = gamesData.response.games.find(g => g.appid === 252490);
            if (rust) {
                hours = Math.round(rust.playtime_forever / 60);
                playtime2w = Math.round((rust.playtime_2weeks || 0) / 60 * 10) / 10;
                lastPlayed = rust.rtime_last_played || null;
            }
        }
    } catch (e) {}

    const rustStats = await getRustStats(steamId);

    // Почему может не быть данных
    const isPublic = player.communityvisibilitystate === 3;
    let reason = null;
    if (!isPublic) reason = 'private_profile';
    else if (!rustStats) reason = hours === null ? 'private_games' : 'no_stats';

    // Присутствие: статус, игра, сессия на сервере
    const inRust = String(player.gameid) === '252490';
    const rec = await updatePresence(steamId, player, true);

    const presence = {
        state: player.personastate || 0,
        lastlogoff: player.lastlogoff || null,
        game: player.gameextrainfo || null,
        inRust,
        session: rec.session,
        lastServer: rec.lastServer,
        playtime2w,
        lastPlayed
    };

    return {
        steamid: steamId,
        name: player.personaname,
        avatar: player.avatarfull,
        profile: player.profileurl,
        hours,
        country: player.loccountrycode || null,
        online: player.personastate || 0,
        presence,
        stats: rustStats,
        reason
    };
}

app.get('/api/player/:id', rateLimit(30, 60 * 1000), async (req, res) => {
    try {
        if (req.params.id.length > 200) throw new Error('Слишком длинный запрос');

        const steamId = await resolveToSteamId(req.params.id);

        const hit = cache.get(steamId);
        if (hit && Date.now() - hit.time < CACHE_TTL) {
            return res.json(hit.data);
        }

        const data = await getPlayerData(steamId);

        if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
        cache.set(steamId, { time: Date.now(), data });

        res.json(data);
    } catch (err) {
        res.status(404).json({ error: err.message });
    }
});

// Отладка: показывает реальные имена статистики, связанные с ресурсами
if (process.env.DEBUG_ROUTES === '1') app.get('/api/debug/:id', async (req, res) => {
    try {
        const steamId = await resolveToSteamId(req.params.id);
        const url = `https://api.steampowered.com/ISteamUserStats/GetUserStatsForGame/v2/?appid=252490&key=${STEAM_API_KEY}&steamid=${steamId}`;
        const data = await (await fetch(url)).json();
        const list = data.playerstats?.stats || [];
        res.json(list);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, () => {
    console.log(`Rust Stats запущен: http://localhost:${PORT}`);
});