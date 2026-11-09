package com.lostak.teewatch

import android.Manifest
import android.location.Geocoder
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale

private val Bg = Color(0xFF0E1A14); private val Card = Color(0xFF16261D); private val Line = Color(0xFF25392D)
private val Ink = Color(0xFFF1EFE6); private val Mute = Color(0xFF9DB1A3); private val Acc = Color(0xFF7BD389); private val Warn = Color(0xFFF2C14E)

fun clock(min: Int): String { val h = min / 60; val m = min % 60; return "${if (h % 12 == 0) 12 else h % 12}${if (m > 0) ":%02d".format(m) else ""} ${if (h < 12) "AM" else "PM"}" }
fun clockHm(hm: String) = hm.split(":").let { clock(it[0].toInt() * 60 + it[1].toInt()) }
fun niceDate(d: String): String = runCatching {
    val x = LocalDate.parse(d); val t = LocalDate.now()
    when (x) { t -> "Today"; t.plusDays(1) -> "Tomorrow"; else -> x.format(DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US)) }
}.getOrDefault(d)
fun money(p: Double) = if (p % 1.0 == 0.0) "%.0f".format(p) else "%.2f".format(p)
fun ago(iso: String?): String = iso?.let { runCatching { val m = Duration.between(Instant.parse(it), Instant.now()).toMinutes()
    when { m < 1 -> "just now"; m < 60 -> "$m min ago"; m < 1440 -> "${m / 60} h ago"; else -> "${m / 1440} d ago" } }.getOrNull() } ?: "never"

/** "7", "7:30", "7am", "1pm", "13:00" → "HH:MM"; "1"–"5" without am/pm mean afternoon. */
fun parseClock(s: String): String? {
    val m = Regex("^\\s*(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a|p)?\\s*$", RegexOption.IGNORE_CASE).find(s) ?: return null
    var h = m.groupValues[1].toInt(); val min = m.groupValues[2].ifEmpty { "0" }.toInt(); val ap = m.groupValues[3].lowercase()
    if (ap.startsWith("p") && h < 12) h += 12; if (ap.startsWith("a") && h == 12) h = 0
    if (ap.isEmpty() && h in 1..5) h += 12
    return if (h in 0..23 && min in 0..59) "%02d:%02d".format(h, min) else null
}

class MainActivity : ComponentActivity() {
    private val askNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        CheckWorker.channel(this); CheckWorker.schedule(this)
        if (Build.VERSION.SDK_INT >= 33) askNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
        val prefs = Prefs(this)
        setContent { MaterialTheme(colorScheme = darkColorScheme(primary = Acc, background = Bg, surface = Card, onSurface = Ink, onBackground = Ink)) { App(prefs) } }
    }
}

@Composable
fun App(prefs: Prefs) {
    val repo = remember { Repo(prefs) }
    val scope = rememberCoroutineScope()
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var st by remember { mutableStateOf(repo.cached()) }
    var fileWants by remember { mutableStateOf<List<Want>?>(null) }
    var courses by remember { mutableStateOf(emptyList<String>()) }
    var busy by remember { mutableStateOf(false) }
    var msg by remember { mutableStateOf<String?>(null) }
    var adding by remember { mutableStateOf(false) }
    var settings by remember { mutableStateOf(false) }
    var tokenSet by remember { mutableStateOf(prefs.token.isNotEmpty()) }

    fun load() = scope.launch {
        busy = true; msg = null
        try {
            val s = withContext(Dispatchers.IO) { repo.state() }; st = s
            CheckWorker.notifyNew(ctx, prefs, s)
            fileWants = withContext(Dispatchers.IO) { runCatching { repo.wantsFile().json.optJSONArray("wants") }.getOrNull() }
                ?.let { a -> List(a.length()) { Repo.want(a.getJSONObject(it), "app") } }
            if (courses.isEmpty()) courses = withContext(Dispatchers.IO) { repo.courses() }
        } catch (e: Exception) { msg = e.message ?: "Couldn't reach GitHub" }
        busy = false
    }
    fun act(done: String, f: () -> Unit) = scope.launch {
        busy = true; msg = null
        try { withContext(Dispatchers.IO) { f() }; msg = done } catch (e: Exception) { msg = e.message ?: "That didn't work" }
        busy = false; load()
    }
    LaunchedEffect(Unit) { load() }

    val today = LocalDate.now().toString()
    val wants = ((st?.wants?.filter { it.source == "calendar" } ?: emptyList()) + (fileWants ?: st?.wants?.filter { it.source != "calendar" } ?: emptyList()))
        .filter { it.date >= today }.distinct().sortedWith(compareBy({ it.date }, { it.from }))
    val found = st?.found?.filter { it.date >= today } ?: emptyList()

    Surface(Modifier.fillMaxSize(), color = Bg) {
        LazyColumn(Modifier.fillMaxSize().systemBarsPadding().padding(horizontal = 16.dp), contentPadding = PaddingValues(vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            item {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("Tee Watch", color = Ink, fontSize = 26.sp, fontWeight = FontWeight.Bold)
                        Text("Checked ${ago(st?.checked ?: st?.updated)} · ${prefs.repo}", color = Mute, fontSize = 13.sp)
                    }
                    TextButton(onClick = { settings = true }) { Text("Settings", color = Acc) }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(onClick = { adding = true }, enabled = !busy) { Text("Watch a day") }
                    OutlinedButton(onClick = { load() }, enabled = !busy) { Text("Refresh") }
                    if (tokenSet) OutlinedButton(onClick = { act("Check started – results in a few minutes") { repo.checkNow() } }, enabled = !busy) { Text("Check now") }
                    if (busy) CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
                }
                msg?.let { Text(it, color = Warn, fontSize = 14.sp, modifier = Modifier.padding(top = 6.dp)) }
                if (!tokenSet) Text("Read-only: add a GitHub token in Settings to add or remove days from here.", color = Mute, fontSize = 13.sp, modifier = Modifier.padding(top = 6.dp))
            }

            item { Header("Open now", if (found.isEmpty()) null else "${found.size}") }
            if (found.isEmpty()) item { Note(if (wants.isEmpty()) "Watch a day and open tee times that fit will show up here – with a notification when a new one opens." else "Nothing open that fits yet. You'll get a notification when one opens.") }
            found.groupBy { it.date }.forEach { (d, list) ->
                item { Text(niceDate(d), color = Mute, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
                items(list, key = { it.key }) { TeeRow(it) }
            }
            if (st?.errors?.isNotEmpty() == true) item { Note("Couldn't read last time: ${st!!.errors.joinToString()}") }

            item { Header("Watching", null) }
            if (wants.isEmpty()) item { Note("No days yet.") }
            items(wants, key = { "${it.source}|${it.date}|${it.from}|${it.to}|${it.players}|${it.courses}" }) { w ->
                Box(Modifier.fillMaxWidth().background(Card, RoundedCornerShape(12.dp)).padding(12.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("${niceDate(w.date)} · ${windowText(w.from, w.to)}", color = Ink, fontSize = 16.sp, fontWeight = FontWeight.SemiBold)
                            Text("${w.players} player${if (w.players == 1) "" else "s"}" + (if (w.courses.isNotEmpty()) " · " + w.courses.joinToString() else st?.courseFilter?.let { " · " + it.replace("|", ", ") } ?: " · any course") +
                                (if (w.source == "calendar") " · from your calendar" else ""), color = Mute, fontSize = 13.sp)
                        }
                        if (w.source != "calendar" && tokenSet) TextButton(onClick = { act("Stopped watching ${niceDate(w.date)}") { repo.removeWant(w) } }, enabled = !busy) { Text("Remove", color = Warn) }
                    }
                }
            }

            val report = st?.report.orEmpty()
            if (report.isNotEmpty()) {
                item { Header("Daily report", st?.reportDate?.let { niceDate(it) }) }
                item { Note("Earliest daylight time at each course, any time of day.") }
                report.filterKeys { it >= today }.forEach { (d, list) ->
                    item { Text(niceDate(d) + if (list.isEmpty()) " – nothing open" else "", color = Mute, fontSize = 14.sp, fontWeight = FontWeight.SemiBold) }
                    items(list.take(8), key = { "r|$d|${it.course}|${it.min}" }) { TeeRow(it) }
                }
            }
            item {
                Text("Tee Watch only shows tee times and opens the course's booking page. It never books, signs in or pays for anything.",
                    color = Mute, fontSize = 12.sp, modifier = Modifier.padding(top = 12.dp))
            }
        }
    }

    if (adding) AddDialog(courses, onDismiss = { adding = false }) { w ->
        adding = false
        if (!tokenSet) { msg = "Add a GitHub token in Settings first – it's what lets the app change the watch list"; settings = true }
        else act("Watching ${niceDate(w.date)} ${windowText(w.from, w.to)}") { repo.addWant(w) }
    }
    if (settings) SettingsDialog(prefs, st, onDismiss = { settings = false; tokenSet = prefs.token.isNotEmpty(); load() }) { lat, lng, r ->
        act("Search area saved") { repo.setArea(lat, lng, r) }
    }
}

fun windowText(from: String, to: String) = if (from <= "05:00" && to >= "20:00") "any time" else "${clockHm(from)}–${clockHm(to)}"

@Composable private fun Header(t: String, side: String?) = Row(Modifier.padding(top = 10.dp), verticalAlignment = Alignment.Bottom) {
    Text(t, color = Ink, fontSize = 19.sp, fontWeight = FontWeight.Bold, modifier = Modifier.weight(1f))
    side?.let { Text(it, color = Mute, fontSize = 13.sp) }
}
@Composable private fun Note(t: String) = Text(t, color = Mute, fontSize = 14.sp)

@Composable
private fun TeeRow(t: Tee) {
    val uri = LocalUriHandler.current
    Row(Modifier.fillMaxWidth().background(Card, RoundedCornerShape(12.dp)).clickable { runCatching { uri.openUri(t.link) } }.padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Text(clock(t.min), color = Acc, fontSize = 16.sp, fontWeight = FontWeight.Bold, modifier = Modifier.width(84.dp))
        Column(Modifier.weight(1f)) {
            Text(t.course, color = Ink, fontSize = 15.sp)
            Text("${t.spots} spot${if (t.spots == 1) "" else "s"}${t.price?.let { " · $" + money(it) } ?: ""}", color = Mute, fontSize = 13.sp)
        }
        Text("Book ›", color = Acc, fontSize = 14.sp)
    }
}

@Composable
private fun Chip(label: String, on: Boolean, click: () -> Unit) = FilterChip(selected = on, onClick = click, label = { Text(label) })

@Composable
private fun AddDialog(courses: List<String>, onDismiss: () -> Unit, onAdd: (Want) -> Unit) {
    val days = remember { (0..20).map { LocalDate.now().plusDays(it.toLong()) } }
    var day by remember { mutableStateOf(days.first { it.dayOfWeek.value >= 6 }) }
    var from by remember { mutableStateOf("7am") }; var to by remember { mutableStateOf("11am") }
    var players by remember { mutableIntStateOf(2) }
    var picked by remember { mutableStateOf(setOf<String>()) }
    var search by remember { mutableStateOf("") }
    val f = parseClock(from); val t = parseClock(to)
    AlertDialog(onDismissRequest = onDismiss, containerColor = Card,
        title = { Text("Watch a day", color = Ink) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    days.forEach { d -> Chip(if (d == days[0]) "Today" else d.format(DateTimeFormatter.ofPattern("EEE d", Locale.US)), d == day) { day = d } }
                }
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    listOf("Early" to ("6am" to "9am"), "Morning" to ("7am" to "11am"), "Midday" to ("10am" to "2pm"), "Afternoon" to ("12pm" to "5pm"), "Any time" to ("5am" to "9pm"))
                        .forEach { (l, w) -> Chip(l, from == w.first && to == w.second) { from = w.first; to = w.second } }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedTextField(from, { from = it }, Modifier.weight(1f), label = { Text("From") }, singleLine = true, isError = f == null)
                    OutlinedTextField(to, { to = it }, Modifier.weight(1f), label = { Text("To") }, singleLine = true, isError = t == null || (f != null && t <= f))
                }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("Players", color = Mute); (1..4).forEach { n -> Chip("$n", n == players) { players = n } }
                }
                Text(if (picked.isEmpty()) "Courses: any" else "Courses: ${picked.joinToString()}", color = Mute, fontSize = 13.sp)
                if (courses.isNotEmpty()) {
                    OutlinedTextField(search, { search = it }, Modifier.fillMaxWidth(), label = { Text("Only these courses (optional)") }, singleLine = true)
                    val shown = courses.filter { search.isNotBlank() && it.contains(search.trim(), true) || it in picked }.take(12)
                    shown.forEach { c ->
                        Row(Modifier.fillMaxWidth().clickable { picked = if (c in picked) picked - c else picked + c }, verticalAlignment = Alignment.CenterVertically) {
                            Checkbox(c in picked, { picked = if (c in picked) picked - c else picked + c }); Text(c, color = Ink, fontSize = 14.sp)
                        }
                    }
                }
            }
        },
        confirmButton = { Button(enabled = f != null && t != null && t > f, onClick = { onAdd(Want(day.toString(), f!!, t!!, players, picked.toList().sorted(), "app")) }) { Text("Watch") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel", color = Mute) } })
}

@Composable
private fun SettingsDialog(prefs: Prefs, st: AppState?, onDismiss: () -> Unit, onArea: (Double, Double, Int) -> Unit) {
    val uri = LocalUriHandler.current
    val ctx = androidx.compose.ui.platform.LocalContext.current
    var repo by remember { mutableStateOf(prefs.repo) }
    var token by remember { mutableStateOf(prefs.token) }
    var notify by remember { mutableStateOf(prefs.notify) }
    var place by remember { mutableStateOf("") }
    var radius by remember { mutableStateOf((st?.radiusMiles ?: 30).toString()) }
    var areaMsg by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(onDismissRequest = { prefs.repo = repo; prefs.token = token; prefs.notify = notify; onDismiss() }, containerColor = Card,
        title = { Text("Settings", color = Ink) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(repo, { repo = it }, Modifier.fillMaxWidth(), label = { Text("Watcher repo (owner/name)") }, singleLine = true)
                OutlinedTextField(token, { token = it }, Modifier.fillMaxWidth(), label = { Text("GitHub token (to change what's watched)") }, singleLine = true,
                    visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password))
                Text("Make one at GitHub → Settings → Developer settings → Fine-grained tokens: only this repo, with Contents and Actions set to Read and write. It stays on this phone.",
                    color = Mute, fontSize = 13.sp)
                TextButton(onClick = { runCatching { uri.openUri("https://github.com/settings/personal-access-tokens/new") } }) { Text("Open GitHub token page", color = Acc) }
                HorizontalDivider(color = Line)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("Notify me when a tee time opens", color = Ink, modifier = Modifier.weight(1f)); Switch(notify, { notify = it })
                }
                HorizontalDivider(color = Line)
                Text("Search area" + (st?.radiusMiles?.let { " (now $it mi" + (st.center?.let { c -> " around %.3f, %.3f".format(c.first, c.second) } ?: "") + ")" } ?: ""), color = Ink)
                OutlinedTextField(place, { place = it }, Modifier.fillMaxWidth(), label = { Text("City or ZIP") }, singleLine = true)
                OutlinedTextField(radius, { radius = it.filter(Char::isDigit).take(3) }, Modifier.fillMaxWidth(), label = { Text("Miles") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number))
                OutlinedButton(enabled = place.isNotBlank() && radius.isNotBlank() && token.isNotBlank(), onClick = {
                    prefs.token = token; prefs.repo = repo
                    scope.launch {
                        @Suppress("DEPRECATION")
                        val hit = withContext(Dispatchers.IO) { runCatching { Geocoder(ctx, Locale.US).getFromLocationName(place, 1)?.firstOrNull() }.getOrNull() }
                        if (hit == null) areaMsg = "Couldn't find \"$place\"" else { areaMsg = "Saved: ${hit.locality ?: place}"; onArea(hit.latitude, hit.longitude, radius.toInt().coerceIn(5, 100)) }
                    }
                }) { Text("Save search area") }
                areaMsg?.let { Text(it, color = Warn, fontSize = 13.sp) }
            }
        },
        confirmButton = { Button(onClick = { prefs.repo = repo; prefs.token = token; prefs.notify = notify; onDismiss() }) { Text("Done") } })
}
