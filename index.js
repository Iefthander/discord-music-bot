require('dotenv').config();
const { Client, GatewayIntentBits, REST, Routes, MessageFlags } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, NoSubscriberBehavior, VoiceConnectionStatus, StreamType } = require('@discordjs/voice');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

process.on('unhandledRejection', err => {
    if (err && err.message && err.message.includes('IP discovery')) return;
    console.error('[UnhandledRejection]', err.message || err);
});

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
if (!TOKEN || !CLIENT_ID) { console.error('Укажите DISCORD_TOKEN и CLIENT_ID в .env!'); process.exit(1); }

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const queue = new Map();
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);
const ytdlpPath = path.join(__dirname, 'yt-dlp.exe');

const commands = [
    { name: 'play', description: 'Включить трек с YouTube', options: [{ name: 'url', type: 3, description: 'Ссылка YouTube', required: true }] },
    { name: 'skip', description: 'Пропустить трек' },
    { name: 'stop', description: 'Остановить и отключиться!' },
    { name: 'queue', description: 'Очередь треков' },
    { name: 'nowplaying', description: 'Текущий трек' }
];

client.once('clientReady', async () => {
    console.log(`Бот ${client.user.tag} запущен!`);
    try {
        const rest = new REST({ version: '10' }).setToken(TOKEN);
        await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
        console.log('Команды зарегистрированы.');
    } catch (e) {
        console.error('Ошибка регистрации команд:', e);
    }
});

client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const guildId = interaction.guildId;
    const member = interaction.member;

    try {
        if (commandName === 'play') {
            const url = interaction.options.getString('url');
            if (!url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/)) {
                await interaction.reply({ content: 'Укажите ссылку на YouTube видео.', flags: 64 });
                return;
            }
            if (!member.voice.channel) {
                await interaction.reply({ content: 'Вы должны быть в голосовом канале!', flags: 64 });
                return;
            }

            await interaction.reply({ content: 'Загружаю трек...' });

            let serverQueue = queue.get(guildId);

            if (!serverQueue) {
                const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });

                const construct = {
                    textChannel: interaction.channel,
                    voiceChannel: member.voice.channel,
                    connection: null,
                    player: player,
                    songs: [],
                    loadingMessage: null
                };

                queue.set(guildId, construct);
                construct.songs.push({ url, title: null, addedBy: interaction.user.tag });

                try {
                    const connection = joinVoiceChannel({
                        channelId: member.voice.channel.id,
                        guildId: guildId,
                        adapterCreator: member.voice.guild.voiceAdapterCreator,
                    });

                    connection.on('stateChange', (oldState, newState) => {
                        if (newState.status === VoiceConnectionStatus.Destroyed) {
                            player.stop(true);
                        }
                    });

                    construct.connection = connection;
                    connection.subscribe(player);

                    construct.loadingMessage = await interaction.fetchReply();
                    playSong(guildId);
                } catch (err) {
                    console.error(err);
                    queue.delete(guildId);
                    await interaction.editReply('Не удалось подключиться к голосовому каналу.');
                }
            } else {
                serverQueue.songs.push({ url, title: null, addedBy: interaction.user.tag });
                const pos = serverQueue.songs.length;
                await interaction.editReply(`Трек добавлен в очередь (#${pos}).`);
            }
            return;
        }

        if (commandName === 'skip') {
            if (!member.voice.channel) {
                await interaction.reply({ content: 'Вы должны быть в голосовом канале!', flags: 64 });
                return;
            }
            const sq = queue.get(guildId);
            if (!sq || sq.songs.length === 0) {
                await interaction.reply({ content: 'Ничего не играет.', flags: 64 });
                return;
            }
            await interaction.reply('Пропускаю...');
            sq.player.stop();
            return;
        }

        if (commandName === 'stop') {
            if (!member.voice.channel) {
                await interaction.reply({ content: 'Вы должны быть в голосовом канале!', flags: 64 });
                return;
            }
            const sq = queue.get(guildId);
            if (!sq) {
                await interaction.reply({ content: 'Бот не играет.', flags: 64 });
                return;
            }
            await interaction.reply('Останавливаю.');
            sq.songs = [];
            sq.player.stop();
            if (sq.connection) sq.connection.destroy();
            queue.delete(guildId);
            cleanupTemp();
            return;
        }

        if (commandName === 'queue') {
            const sq = queue.get(guildId);
            if (!sq || sq.songs.length === 0) {
                await interaction.reply({ content: 'Очередь пуста.', flags: 64 });
                return;
            }
            const list = sq.songs.map((s, i) => `${i === 0 ? '▶' : i + '.'} ${s.title || s.url}`).join('\n');
            await interaction.reply({ content: `**Очередь:**\n${list}`, flags: 64 });
            return;
        }

        if (commandName === 'nowplaying') {
            const sq = queue.get(guildId);
            if (!sq || sq.songs.length === 0) {
                await interaction.reply({ content: 'Ничего не играет.', flags: 64 });
                return;
            }
            await interaction.reply({ content: `Играет: **${sq.songs[0].title || sq.songs[0].url}**`, flags: 64 });
            return;
        }
    } catch (err) {
        console.error('[Interaction Error]', err.message || err);
    }
});

function playSong(guildId) {
    const sq = queue.get(guildId);
    if (!sq || sq.songs.length === 0) {
        setTimeout(() => {
            const q = queue.get(guildId);
            if (q && q.songs.length === 0) {
                if (q.connection) q.connection.destroy();
                q.textChannel.send('Очередь пуста, отключаюсь.');
                queue.delete(guildId);
                cleanupTemp();
            }
        }, 30000);
        return;
    }

    const current = sq.songs[0];
    const outputFilePath = path.join(tempDir, `${Date.now()}.mp3`);

    console.log(`[Загрузка] ${current.url}`);

    const cmd = `"${ytdlpPath}" -f "ba/ba*" --extract-audio --audio-format mp3 --js-runtimes node:"D:\\NodeJs\\node.exe" --cookies-from-browser firefox --extractor-args "youtube:player_client=web" -o "${outputFilePath}" "${current.url}"`;

    exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
        if (!err) {
            console.log('[yt-dlp] Скачано через Firefox cookies + web client');
            return onDownloaded(guildId, outputFilePath);
        }
        console.error('[yt-dlp] Ошибка:', stderr || err.message);
        if (sq.loadingMessage) sq.loadingMessage.edit('Не удалось загрузить трек. Возможно, нужно обновить куки Firefox.').catch(() => {});
        sq.songs.shift();
        playSong(guildId);
    });
}

function onDownloaded(guildId, filePath) {
    const sq = queue.get(guildId);
    if (!sq || sq.songs.length === 0) { try { fs.unlinkSync(filePath); } catch(e) {} return; }

    const current = sq.songs[0];
    const infoCmd = `"${ytdlpPath}" --print title --skip-download --js-runtimes node:"D:\\NodeJs\\node.exe" --cookies-from-browser firefox --extractor-args "youtube:player_client=web" "${current.url}"`;
    exec(infoCmd, { timeout: 30000 }, (err, stdout) => {
        if (!err && stdout.trim()) current.title = stdout.trim();
        if (sq.loadingMessage) {
            sq.loadingMessage.edit(`Играет: **${current.title || current.url}**`).catch(() => {});
        }
        playLocalFile(guildId, filePath);
    });
}

function playLocalFile(guildId, filePath) {
    const sq = queue.get(guildId);
    if (!sq || sq.songs.length === 0) { try { fs.unlinkSync(filePath); } catch(e) {} return; }

    if (!fs.existsSync(filePath)) {
        sq.textChannel.send('Файл трека не найден.');
        sq.songs.shift();
        playSong(guildId);
        return;
    }

    console.log(`[Плеер] Транскодирую: ${filePath}`);

    const ffmpegPath = 'D:\\ffmpeg\\ffmpeg-2026-07-16-git-ceabc9b306-essentials_build\\bin\\ffmpeg.exe';

    const ffmpeg = spawn(ffmpegPath, [
        '-i', filePath,
        '-f', 's16le',
        '-ar', '48000',
        '-ac', '2',
        'pipe:1'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let ffmpegError = '';
    ffmpeg.stderr.on('data', (data) => { ffmpegError += data.toString(); });

    ffmpeg.on('error', (err) => {
        console.error('[FFmpeg Ошибка запуска]:', err.message);
        try { fs.unlinkSync(filePath); } catch(e) {}
        sq.songs.shift();
        playSong(guildId);
    });

    ffmpeg.on('close', (code) => {
        if (code !== 0) {
            console.error(`[FFmpeg] Код выхода: ${code}`, ffmpegError.slice(0, 500));
        }
    });

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    sq.player.play(resource);

    const cleanup = (reason) => {
        console.log(`[Плеер] Трек завершился (${reason}).`);
        try { ffmpeg.kill(); } catch(e) {}
        try { fs.unlinkSync(filePath); } catch(e) {}
        sq.player.removeAllListeners('error');
        sq.player.removeAllListeners(AudioPlayerStatus.Idle);
        sq.songs.shift();
        playSong(guildId);
    };

    sq.player.once(AudioPlayerStatus.Idle, () => cleanup('idle'));

    sq.player.once('error', (error) => {
        console.error('[Плеер Ошибка]:', error.message);
        cleanup('error');
    });
}

function cleanupTemp() {
    try {
        for (const f of fs.readdirSync(tempDir)) {
            try { fs.unlinkSync(path.join(tempDir, f)); } catch(e) {}
        }
    } catch(e) {}
}

client.login(TOKEN);
