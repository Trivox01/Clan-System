import { Client, GatewayIntentBits, Partials, Collection, ActivityType } from "discord.js";
import dotenv from "dotenv";
import { connectMongo, disconnectMongo, getMongoStatus } from "./database/connect.js";
import { db } from "./database/db.js";
import { command as clanBaseCommand } from "./commands/clan/clanBase.js";
import { event as interactionEvent, initDisbandScheduler, initXpBuffSanitizer, initSecuritySystems } from "./events/interactionCreate.js";
import { event as voiceXpEvent, messageXpEvent } from "./events/voiceAndTextXP.js";
import { event as readyEvent } from "./events/ready.js";
import { forceFlushAll } from "./utils/securityLogger.js";
import { gracefulShutdown as gracefulSaveShutdown } from "./utils/debouncedSave.js";

dotenv.config();

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * 🤖 LEGENDARY CLANS BOT - Multi-Tenant Multi-Server
 * ═══════════════════════════════════════════════════════════════════════════════
 * 
 * الإصدار 3.0 - يدعم:
 * - MongoDB للتخزين الدائم
 * - Multi-tenant: كل سيرفر له بياناته المستقلة
 * - In-memory cache للأداء العالي
 * - Auto-scaling عبر عدد غير محدود من السيرفرات
 * 
 * كل ما تحتاجه:
 * 1. شغّل MongoDB (محلي أو Atlas)
 * 2. حط DISCORD_TOKEN و MONGODB_URI في .env
 * 3. node index.js
 */

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildIntegrations
    ],
    partials: [Partials.Channel, Partials.GuildMember, Partials.Message]
});

client.commands = new Collection();

// ═══════════════════════════════════════════════════════════════════
// 🛡️ ERROR HANDLERS
// ═══════════════════════════════════════════════════════════════════

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
    shutdown('UNCAUGHT_EXCEPTION');
});

// ═══════════════════════════════════════════════════════════════════
// 🎮 EVENT REGISTRATION
// ═══════════════════════════════════════════════════════════════════

client.commands.set(clanBaseCommand.data.name, clanBaseCommand);

client.on(readyEvent.name, (...args) => readyEvent.execute(...args, client));
client.on(interactionEvent.name, (...args) => interactionEvent.execute(...args, client));
client.on(voiceXpEvent.name, (...args) => voiceXpEvent.execute(...args, client));
client.on(messageXpEvent.name, (...args) => messageXpEvent.execute(...args, client));

// Guild joined - إنشاء config تلقائي
client.on('guildCreate', async (guild) => {
    console.log(`📥 تم الانضمام لسيرفر جديد: ${guild.name} (${guild.id})`);
    try {
        await db.getGuildConfig(guild.id);
        console.log(`✅ تم تهيئة إعدادات السيرفر ${guild.id}`);
    } catch (e) {
        console.error(`❌ فشل تهيئة السيرفر ${guild.id}:`, e.message);
    }
});

client.on('guildDelete', async (guild) => {
    console.log(`📤 تم الخروج من سيرفر: ${guild.name} (${guild.id})`);
    db.invalidateGuild(guild.id);
});

// ═══════════════════════════════════════════════════════════════════
// 🚀 START BOT
// ═══════════════════════════════════════════════════════════════════

async function startBot() {
    console.log("═".repeat(60));
    console.log("⏳ جاري تشغيل بوت الكلانات الأسطوري v3.0 (Multi-Server)");
    console.log("═".repeat(60));

    // 🍃 الاتصال بـ MongoDB أولاً
    console.log("🍃 جاري الاتصال بـ MongoDB...");
    try {
        await connectMongo();
        const status = getMongoStatus();
        console.log(`✅ MongoDB متصل على ${status.host}/${status.name}`);
    } catch (error) {
        console.error("❌ فشل الاتصال بـ MongoDB:", error.message);
        console.error("\n💡 تأكد من:");
        console.error("   1. MongoDB شغال (أو Atlas URI صحيح)");
        console.error("   2. MONGODB_URI موجود في .env");
        console.error("   3. الـ IP مضاف للـ whitelist (في Atlas)");
        process.exit(1);
    }

    await db.load();

    // 🆕 تفعيل أنظمة الأمان
    await initSecuritySystems(db);

    // 📊 عرض إحصائيات سريعة
    const stats = await db.getStats();
    console.log(`📊 الإحصائيات: ${stats.clans || 0} كلان في ${stats.guilds || 0} سيرفر`);

    // 📋 تسجيل المجدولين
    initDisbandScheduler(client, db);
    initXpBuffSanitizer(client, db);

    // 🆕 Graceful Shutdown
    const shutdown = async (signal) => {
        console.log(`\n🛑 استقبل إشارة ${signal} - جاري الإغلاق الآمن...`);

        try {
            // حفظ كل التغييرات المعلقة
            await gracefulSaveShutdown();
            await forceFlushAll();
            console.log('💾 تم حفظ البيانات');

            // قطع الاتصال بـ Discord
            client.destroy();
            console.log('👋 تم قطع الاتصال بـ Discord');

            // قطع الاتصال بـ MongoDB
            await disconnectMongo();
            console.log('🍃 تم قطع الاتصال بـ MongoDB');
        } catch (e) {
            console.error('❌ خطأ في الإغلاق الآمن:', e.message);
        }
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    // 🔐 تسجيل الدخول في Discord
    if (!process.env.DISCORD_TOKEN) {
        console.error('❌ DISCORD_TOKEN غير موجود في .env');
        process.exit(1);
    }

    await client.login(process.env.DISCORD_TOKEN);
}

startBot().catch(error => {
    console.error("❌ فشل كلي في عملية بدء تشغيل البوت:", error);
    process.exit(1);
});
