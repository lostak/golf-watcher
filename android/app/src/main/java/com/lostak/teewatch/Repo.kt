package com.lostak.teewatch

import android.content.Context
import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.ZoneId

// Tee Watch is a front end for a golf-watcher GitHub repo (default: the public lostak/golf-watcher). The repo's
// Actions do the checking every 5 minutes; this app only reads and writes two files in it:
//   golf-watcher/state/app.json  – written by the watcher: days watched, open tee times that fit them, daily report
//   golf-watcher/wants.json      – the days to watch; the app adds/removes days here (needs a GitHub token)
// Reading needs nothing. Writing needs a fine-grained token with Contents + Actions read/write on that one repo.

data class Want(val date: String, val from: String, val to: String, val players: Int, val courses: List<String>, val source: String)
data class Tee(val date: String, val min: Int, val course: String, val spots: Int, val price: Double?, val link: String, val key: String)
data class AppState(
    val updated: String?, val checked: String?, val wants: List<Want>, val found: List<Tee>,
    val reportDate: String?, val report: Map<String, List<Tee>>, val errors: List<String>,
    val radiusMiles: Int?, val center: Pair<Double, Double>?, val courseFilter: String?,
)
data class FileWants(val json: JSONObject, val sha: String?)

class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("teewatch", Context.MODE_PRIVATE)
    var repo: String get() = p.getString("repo", null)?.takeIf { it.isNotBlank() } ?: DEFAULT_REPO; set(v) = p.edit().putString("repo", v.trim()).apply()
    var branch: String get() = p.getString("branch", null)?.takeIf { it.isNotBlank() } ?: "main"; set(v) = p.edit().putString("branch", v.trim()).apply()
    var token: String get() = p.getString("token", "") ?: ""; set(v) = p.edit().putString("token", v.trim()).apply()
    var notify: Boolean get() = p.getBoolean("notify", true); set(v) = p.edit().putBoolean("notify", v).apply()
    var notified: Set<String> get() = p.getStringSet("notified", null) ?: emptySet(); set(v) = p.edit().putStringSet("notified", v).apply()
    var seeded: Boolean get() = p.getBoolean("seeded", false); set(v) = p.edit().putBoolean("seeded", v).apply()
    var cache: String? get() = p.getString("cache", null); set(v) = p.edit().putString("cache", v).apply()
    companion object { const val DEFAULT_REPO = "lostak/golf-watcher" }
}

class GitHubError(msg: String) : Exception(msg)

class Repo(private val prefs: Prefs) {
    private val dir = "golf-watcher"
    private val api get() = "https://api.github.com/repos/${prefs.repo}"

    private fun http(url: String, method: String = "GET", body: String? = null, accept: String = "application/vnd.github+json", auth: Boolean = true): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.requestMethod = method; c.connectTimeout = 15000; c.readTimeout = 20000; c.useCaches = false
        c.setRequestProperty("Accept", accept)
        c.setRequestProperty("User-Agent", "TeeWatch-Android")
        c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
        if (auth && prefs.token.isNotEmpty()) c.setRequestProperty("Authorization", "Bearer ${prefs.token}")
        if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toByteArray()) } }
        val code = c.responseCode
        val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
        if (code >= 400) throw GitHubError(when (code) {
            401 -> "GitHub didn't accept the token (expired or mistyped?)"
            403 -> if (text.contains("rate limit", true)) "GitHub's hourly limit was hit – add a token in Settings, or try again later" else "The token can't do that – it needs Contents and Actions (read and write) on ${prefs.repo}"
            404 -> "Not found on GitHub: check the repo name in Settings (${prefs.repo})"
            422 -> "GitHub refused the change: ${JSONObject(text.ifEmpty { "{}" }).optString("message")}"
            else -> "GitHub answered $code"
        })
        return text
    }

    /** A file's text: through the API with a token (always fresh), else the public raw URL. */
    private fun read(path: String): String =
        if (prefs.token.isNotEmpty()) http("$api/contents/$dir/$path?ref=${prefs.branch}", accept = "application/vnd.github.raw+json")
        else http("https://raw.githubusercontent.com/${prefs.repo}/${prefs.branch}/$dir/$path?t=${System.currentTimeMillis() / 60000}", accept = "*/*", auth = false)

    fun state(): AppState { val t = read("state/app.json"); prefs.cache = t; return parseState(t) }
    fun cached(): AppState? = prefs.cache?.let { runCatching { parseState(it) }.getOrNull() }
    fun courses(): List<String> = runCatching { JSONArray(read("state/courses.json")).let { a -> List(a.length()) { a.getString(it) } } }.getOrDefault(emptyList())

    fun wantsFile(): FileWants {
        if (prefs.token.isEmpty()) return FileWants(JSONObject(read("wants.json")), null)
        val j = JSONObject(http("$api/contents/$dir/wants.json?ref=${prefs.branch}"))
        val text = String(Base64.decode(j.getString("content").replace("\n", ""), Base64.DEFAULT))
        return FileWants(JSONObject(text), j.getString("sha"))
    }

    private fun saveWants(f: FileWants, message: String) {
        if (prefs.token.isEmpty()) throw GitHubError("Add a GitHub token in Settings to change what's watched")
        val body = JSONObject().put("message", message).put("branch", prefs.branch)
            .put("content", Base64.encodeToString(f.json.toString(2).plus("\n").toByteArray(), Base64.NO_WRAP))
        if (f.sha != null) body.put("sha", f.sha)
        http("$api/contents/$dir/wants.json", "PUT", body.toString())
        runCatching { checkNow() }   // start a check right away (tick.yml would also pick it up within 5 minutes)
    }

    fun addWant(w: Want) {
        val f = wantsFile(); val arr = f.json.optJSONArray("wants") ?: JSONArray()
        val today = LocalDate.now(ZoneId.systemDefault()).toString()
        val keep = JSONArray(); for (i in 0 until arr.length()) arr.optJSONObject(i)?.takeIf { it.optString("date") >= today }?.let { keep.put(it) }
        val o = JSONObject().put("date", w.date).put("from", w.from).put("to", w.to).put("players", w.players)
        if (w.courses.isNotEmpty()) o.put("courses", JSONArray(w.courses))
        keep.put(o); f.json.put("wants", keep)
        saveWants(f, "Tee Watch: watch ${w.date} ${w.from}-${w.to} for ${w.players}")
    }

    fun removeWant(w: Want) {
        val f = wantsFile(); val arr = f.json.optJSONArray("wants") ?: JSONArray(); val keep = JSONArray()
        for (i in 0 until arr.length()) { val o = arr.optJSONObject(i) ?: continue
            if (!(o.optString("date") == w.date && o.optString("from").padStart(5, '0') == w.from && o.optString("to").padStart(5, '0') == w.to && o.optInt("players") == w.players)) keep.put(o) }
        f.json.put("wants", keep)
        saveWants(f, "Tee Watch: stop watching ${w.date} ${w.from}-${w.to}")
    }

    fun setArea(lat: Double, lng: Double, radius: Int) {
        val f = wantsFile()
        f.json.put("center", JSONObject().put("lat", lat).put("lng", lng)).put("radiusMiles", radius)
        saveWants(f, "Tee Watch: search ${radius} mi around %.4f, %.4f".format(lat, lng))
    }

    fun checkNow() { http("$api/actions/workflows/golf-watch.yml/dispatches", "POST", JSONObject().put("ref", prefs.branch).toString()) }

    companion object {
        fun tee(o: JSONObject, date: String? = null) = Tee(
            date = date ?: o.optString("date"), min = o.optInt("min"), course = o.optString("course"), spots = o.optInt("spots"),
            price = if (o.has("price") && !o.isNull("price")) o.optDouble("price") else null, link = o.optString("link"),
            key = o.optString("key").ifEmpty { "${date ?: o.optString("date")}|${o.optString("course")}|${o.optInt("min")}" })

        fun want(o: JSONObject, source: String? = null) = Want(
            date = o.optString("date"), from = o.optString("from").padStart(5, '0'), to = o.optString("to").padStart(5, '0'),
            players = o.optInt("players", 2), courses = o.optJSONArray("courses")?.let { a -> List(a.length()) { a.optString(it) } } ?: emptyList(),
            source = source ?: o.optString("source", "app"))

        fun parseState(text: String): AppState {
            val j = JSONObject(text)
            val wants = j.optJSONArray("wants")?.let { a -> List(a.length()) { want(a.getJSONObject(it)) } } ?: emptyList()
            val found = (j.optJSONArray("found")?.let { a -> List(a.length()) { tee(a.getJSONObject(it)) } } ?: emptyList()).distinctBy { it.key }
            val rep = j.optJSONObject("report"); val days = rep?.optJSONObject("days")
            val report = days?.keys()?.asSequence()?.sorted()?.associateWith { d -> days.getJSONArray(d).let { a -> List(a.length()) { tee(a.getJSONObject(it), d) }.distinctBy { t -> t.course to t.min } } } ?: emptyMap()
            val errs = j.optJSONArray("errors")?.let { a -> List(a.length()) { a.optString(it) } } ?: emptyList()
            val c = j.optJSONObject("center")
            return AppState(j.optString("updated").ifEmpty { null }, j.optString("checked").ifEmpty { null }, wants, found,
                rep?.optString("date"), report, errs, if (j.has("radiusMiles")) j.optInt("radiusMiles") else null,
                c?.let { it.optDouble("lat") to it.optDouble("lng") }, j.optString("courseFilter").takeIf { it.isNotBlank() && it != "null" })
        }
    }
}
