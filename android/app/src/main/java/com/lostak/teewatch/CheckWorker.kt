package com.lostak.teewatch

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.*
import java.time.LocalDate
import java.util.concurrent.TimeUnit

// Every 15 minutes (Android's shortest background interval): read state/app.json and notify about open tee times
// that fit a watched day and haven't been shown before. The first read after install only remembers what's there.
class CheckWorker(ctx: Context, params: WorkerParameters) : CoroutineWorker(ctx, params) {
    override suspend fun doWork(): Result {
        val prefs = Prefs(applicationContext)
        val st = runCatching { Repo(prefs).state() }.getOrElse { return Result.success() }   // offline: try next time
        notifyNew(applicationContext, prefs, st)
        return Result.success()
    }

    companion object {
        private const val CHANNEL = "tee-times"
        fun schedule(ctx: Context) {
            val req = PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()).build()
            WorkManager.getInstance(ctx).enqueueUniquePeriodicWork("tee-watch", ExistingPeriodicWorkPolicy.KEEP, req)
        }

        fun channel(ctx: Context) {
            if (Build.VERSION.SDK_INT >= 26) ctx.getSystemService(NotificationManager::class.java).createNotificationChannel(
                NotificationChannel(CHANNEL, "Open tee times", NotificationManager.IMPORTANCE_HIGH).apply { description = "A tee time opened up on a day you're watching" })
        }

        fun notifyNew(ctx: Context, prefs: Prefs, st: AppState) {
            val today = LocalDate.now().toString()
            val live = st.found.filter { it.date >= today }
            val known = prefs.notified.filter { it.take(10) >= today }.toMutableSet()
            val fresh = live.filter { it.key !in known }
            known += fresh.map { it.key }; prefs.notified = known
            if (!prefs.seeded) { prefs.seeded = true; return }
            if (fresh.isEmpty() || !prefs.notify) return
            if (Build.VERSION.SDK_INT >= 33 && ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) return
            channel(ctx)
            val nm = NotificationManagerCompat.from(ctx)
            val open = PendingIntent.getActivity(ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP), PendingIntent.FLAG_IMMUTABLE)
            fresh.take(4).forEachIndexed { i, t ->
                val book = PendingIntent.getActivity(ctx, 100 + i, Intent(Intent.ACTION_VIEW, Uri.parse(t.link)), PendingIntent.FLAG_IMMUTABLE)
                val n = NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle("${t.course} · ${clock(t.min)}")
                    .setContentText("${niceDate(t.date)} · ${t.spots} spots${t.price?.let { " · $" + money(it) } ?: ""} – tap to book")
                    .setContentIntent(book).setAutoCancel(true).setGroup(CHANNEL)
                    .addAction(0, "Open Tee Watch", open)
                    .setPriority(NotificationCompat.PRIORITY_HIGH).build()
                runCatching { nm.notify(t.key.hashCode(), n) }
            }
            if (fresh.size > 4) runCatching {
                nm.notify(1, NotificationCompat.Builder(ctx, CHANNEL).setSmallIcon(R.drawable.ic_notify)
                    .setContentTitle("${fresh.size} tee times opened up").setContentText("Tap to see them all")
                    .setContentIntent(open).setAutoCancel(true).setGroup(CHANNEL).setGroupSummary(true).build())
            }
        }
    }
}
