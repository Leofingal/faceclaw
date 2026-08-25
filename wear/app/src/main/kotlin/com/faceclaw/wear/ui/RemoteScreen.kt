package com.faceclaw.wear.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.focusable
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.rotary.onRotaryScrollEvent
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.wear.compose.foundation.ExperimentalWearFoundationApi
import androidx.wear.compose.foundation.rememberActiveFocusRequester
import androidx.wear.compose.material.Button
import androidx.wear.compose.material.ButtonDefaults
import androidx.wear.compose.material.Icon
import androidx.wear.compose.material.MaterialTheme
import androidx.wear.compose.material.Text
import androidx.wear.compose.material.TimeText
import com.faceclaw.wear.Command
import com.faceclaw.wear.FingerTapDetector
import com.faceclaw.wear.Gesture
import com.faceclaw.wear.Haptics
import com.faceclaw.wear.OnBodyMonitor
import com.faceclaw.wear.PhoneLink
import com.faceclaw.wear.Prefs
import com.faceclaw.wear.R
import com.faceclaw.wear.SwipeAction
import com.faceclaw.wear.WristTwistDetector
import kotlinx.coroutines.delay
import kotlin.math.abs

private const val MAX_SWIPE_STEPS = 4
/** A two-finger swipe scrolls this many steps: a "page". */
private const val TWO_FINGER_SWIPE_STEPS = 3
private const val FLASH_MS = 160L
private const val ARROW_LIT_MS = 220L
private const val RING_RADIUS_FRACTION = 0.33f
private const val RING_CENTER_Y_FRACTION = 0.47f
private val ARROW_INSET = 6.dp
private val ARROW_SIZE = 18.dp

/** The d-pad directions, for lighting the arrow that was just swiped. */
enum class Arrow { UP, DOWN, LEFT, RIGHT }

/**
 * The touchpad. The whole screen is the pad: tap = select, double-tap =
 * back, hold = long press (released when the finger lifts), two-finger tap =
 * the hold menu ("right click"), swipes in four directions = spatial
 * navigation (crown and two-finger vertical swipes = plain scrolling, a page
 * at a time for the latter). Fingertip pinch-taps from the motion sensors
 * select / go back, and two quick wrist twists go back. The small buttons at
 * the bottom reach the rest.
 */
// rememberActiveFocusRequester (rotary focus) is still experimental in Wear Compose 1.4.
@OptIn(ExperimentalWearFoundationApi::class)
@Composable
fun RemoteScreen(
    link: PhoneLink,
    prefs: Prefs,
    haptics: Haptics,
    onOpenApps: () -> Unit,
    onOpenAssistant: () -> Unit,
    onOpenStatus: () -> Unit,
) {
    val state by link.state.collectAsStateWithLifecycle()
    val linkStatus by link.link.collectAsStateWithLifecycle()
    val notice by link.notice.collectAsStateWithLifecycle()
    val currentPrefs by rememberUpdatedState(prefs)
    val view = LocalView.current
    var holding by remember { mutableStateOf(false) }
    // Brief ring highlight acknowledging a sensor (tip-tap) gesture.
    var flashUntil by remember { mutableStateOf(0L) }
    var flashing by remember { mutableStateOf(false) }
    // Which d-pad arrow lights up for the swipe just sent.
    var litArrow by remember { mutableStateOf<Arrow?>(null) }
    var litTick by remember { mutableStateOf(0L) }
    // Rotary (crown) events are only delivered to a focused node.
    // rememberActiveFocusRequester requests focus through the hierarchical
    // focus machinery; the resume observer below takes it back after every
    // excursion that steals it (the keyboard activity, ambient, screen off).
    val focusRequester = rememberActiveFocusRequester()
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, focusRequester) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) focusRequester.requestFocus()
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    var crownAccumulator by remember { mutableStateOf(0f) }
    // Pad height in px, for the tap zones; written by onSizeChanged, read by
    // the gesture callbacks (plain holder: the callbacks are remembered once).
    val padHeight = remember { floatArrayOf(1f) }

    val keyboardToApp = rememberKeyboardLauncher(
        label = stringResource(R.string.keyboard_label_app),
        onResult = { text -> haptics.click(); link.sendText(text) },
        onUnavailable = { haptics.error() },
    )

    fun scroll(gesture: Gesture, steps: Int) {
        haptics.tick()
        link.sendGesture(gesture, steps)
    }

    fun light(arrow: Arrow) {
        litArrow = arrow
        litTick = System.currentTimeMillis()
    }

    fun click() {
        haptics.click()
        link.sendGesture(Gesture.CLICK)
    }

    fun doubleClick() {
        haptics.doubleClick()
        link.sendGesture(Gesture.DOUBLE_CLICK)
    }

    /** Run a horizontal-swipe action; `left` says which way the finger went. */
    fun perform(action: SwipeAction, left: Boolean) {
        when (action) {
            SwipeAction.NAVIGATE -> { haptics.click(); link.sendGesture(if (left) Gesture.SWIPE_LEFT else Gesture.SWIPE_RIGHT) }
            SwipeAction.SIDEBAR -> { haptics.click(); link.sendCommand(Command.SIDEBAR) }
            SwipeAction.DOUBLE_CLICK -> doubleClick()
            SwipeAction.CLICK -> click()
            SwipeAction.LONG_PRESS -> { haptics.heavy(); link.sendGesture(Gesture.LONG_PRESS) }
            SwipeAction.WAKEWORD -> { haptics.click(); link.sendGesture(Gesture.WAKEWORD) }
            SwipeAction.NONE -> Unit
        }
    }

    /** Whether a vertical swipe means "up", honouring the natural-scroll preference. */
    fun swipeIsUp(dy: Float): Boolean {
        // Ring convention: swiping up means up. "Natural" flips it so the
        // content follows the finger like a touch screen.
        return if (currentPrefs.naturalScroll) dy > 0 else dy < 0
    }

    val callbacks = remember(link, haptics) {
        TouchpadCallbacks(
            onTap = { position ->
                if (currentPrefs.tapZones) {
                    // Top third scrolls up, bottom third down, the middle clicks.
                    val zone = position.y / padHeight[0].coerceAtLeast(1f)
                    when {
                        zone < 1f / 3f -> scroll(Gesture.SCROLL_UP, 1)
                        zone > 2f / 3f -> scroll(Gesture.SCROLL_DOWN, 1)
                        else -> click()
                    }
                } else {
                    click()
                }
            },
            onDoubleTap = { _ -> doubleClick() },
            // Two fingers = back as well: easier than timing a double-tap.
            onTwoFingerTap = { doubleClick() },
            onTwoFingerSwipe = { dx, dy ->
                if (abs(dy) >= abs(dx)) {
                    scroll(if (swipeIsUp(dy)) Gesture.SCROLL_UP else Gesture.SCROLL_DOWN, TWO_FINGER_SWIPE_STEPS)
                } else {
                    perform(if (dx < 0) currentPrefs.swipeLeft else currentPrefs.swipeRight, left = dx < 0)
                }
            },
            onLongPressStart = {
                holding = true
                haptics.heavy()
                link.sendGesture(Gesture.LONG_PRESS_START)
            },
            onLongPressEnd = {
                holding = false
                haptics.click()
                link.sendGesture(Gesture.LONG_PRESS_RELEASE)
            },
            onSwipe = { dx, dy, _ ->
                if (abs(dy) >= abs(dx)) {
                    // One step per swipe, regardless of length: the glasses
                    // repaint per step, and multi-step swipes overshot lists
                    // whenever the display lagged the finger. Fast repeated
                    // swiping, the crown, or a two-finger page swipe cover
                    // long distances instead.
                    val up = swipeIsUp(dy)
                    light(if (up) Arrow.UP else Arrow.DOWN)
                    scroll(if (up) Gesture.SWIPE_UP else Gesture.SWIPE_DOWN, 1)
                } else {
                    light(if (dx < 0) Arrow.LEFT else Arrow.RIGHT)
                    perform(if (dx < 0) currentPrefs.swipeLeft else currentPrefs.swipeRight, left = dx < 0)
                }
            },
        )
    }

    // Motion-sensor gestures only count on a wrist (see OnBodyMonitor).
    val onBody = remember { OnBodyMonitor(view.context) }
    WhileStartedEffect(onBody, start = onBody::start, stop = onBody::stop)

    // Fingertip (pinch) taps from the motion sensors, only while the pad is up.
    val fingerTapsEnabled = prefs.fingerTaps
    val fingerTapDetector = remember(fingerTapsEnabled, link, haptics) {
        if (!fingerTapsEnabled) null else FingerTapDetector(
            context = view.context,
            sensitivity = { currentPrefs.tapSensitivity },
            quietUntil = { haptics.quietUntil() },
            onBody = { onBody.onBody },
            onTap = { flashUntil = System.currentTimeMillis() + FLASH_MS; click() },
            onDoubleTap = { flashUntil = System.currentTimeMillis() + FLASH_MS; doubleClick() },
        )
    }
    WhileStartedEffect(fingerTapDetector, start = { fingerTapDetector?.start() }, stop = { fingerTapDetector?.stop() })
    // Two quick wrist twists = back, from the gyroscope, only while the pad is up.
    val wristTwistEnabled = prefs.wristTwist
    val wristTwistDetector = remember(wristTwistEnabled, link, haptics) {
        if (!wristTwistEnabled) null else WristTwistDetector(
            context = view.context,
            sensitivity = { currentPrefs.twistSensitivity },
            quietUntil = { haptics.quietUntil() },
            onBody = { onBody.onBody },
            onDoubleTwist = { flashUntil = System.currentTimeMillis() + FLASH_MS; doubleClick() },
        )
    }
    WhileStartedEffect(wristTwistDetector, start = { wristTwistDetector?.start() }, stop = { wristTwistDetector?.stop() })
    LaunchedEffect(litTick) {
        if (litTick == 0L) return@LaunchedEffect
        delay(ARROW_LIT_MS)
        litArrow = null
    }
    LaunchedEffect(flashUntil) {
        if (flashUntil == 0L) return@LaunchedEffect
        flashing = true
        delay((flashUntil - System.currentTimeMillis()).coerceAtLeast(1L))
        flashing = false
    }

    // A refused or unanswered gesture gets a distinct buzz, so the wrist knows
    // without looking (the notice pill says why).
    LaunchedEffect(notice?.id) {
        if (notice?.isError == true) haptics.error()
    }


    Box(
        modifier = Modifier
            .fillMaxSize()
            .onRotaryScrollEvent { event ->
                // Clockwise (positive) scrolls down, as in every Wear list.
                crownAccumulator += event.verticalScrollPixels
                val threshold = currentPrefs.crownSensitivity.pixelsPerStep
                var steps = 0
                while (crownAccumulator >= threshold) { crownAccumulator -= threshold; steps++ }
                while (crownAccumulator <= -threshold) { crownAccumulator += threshold; steps-- }
                // Capped low: a fast twirl otherwise outruns the display.
                if (steps > 0) { light(Arrow.DOWN); scroll(Gesture.SCROLL_DOWN, steps.coerceAtMost(2)) }
                if (steps < 0) { light(Arrow.UP); scroll(Gesture.SCROLL_UP, (-steps).coerceAtMost(2)) }
                true
            }
            .focusRequester(focusRequester)
            .focusable()
            .onSizeChanged { padHeight[0] = it.height.toFloat() }
            .pointerInput(callbacks) { detectTouchpadGestures(callbacks) },
    ) {
        // The pad: a ring with a d-pad arrow at each compass point (the one
        // you swiped lights up), the current glasses app in the middle, and
        // the tap legend under it. Brightens while a hold is in progress.
        BoxWithConstraints(modifier = Modifier.fillMaxSize()) {
            val ringRadius = minOf(maxWidth, maxHeight) * RING_RADIUS_FRACTION
            val ringCenterY = maxHeight * RING_CENTER_Y_FRACTION
            val ringColor = if (holding || flashing) MaterialTheme.colors.primary else Color(0xFF2E2E2E)
            Canvas(modifier = Modifier.fillMaxSize()) {
                drawCircle(
                    color = ringColor,
                    radius = ringRadius.toPx(),
                    center = Offset(size.width / 2f, ringCenterY.toPx()),
                    style = Stroke(width = if (holding || flashing) 4f else 2f),
                )
            }

            TimeText()

            ArrowGlyph("▲", litArrow == Arrow.UP, Modifier.align(Alignment.TopCenter).padding(top = ringCenterY - ringRadius + ARROW_INSET))
            ArrowGlyph("▼", litArrow == Arrow.DOWN, Modifier.align(Alignment.TopCenter).padding(top = ringCenterY + ringRadius - ARROW_INSET - ARROW_SIZE))
            ArrowGlyph("◀", litArrow == Arrow.LEFT, Modifier.align(Alignment.TopStart).padding(start = maxWidth / 2 - ringRadius + ARROW_INSET, top = ringCenterY - ARROW_SIZE / 2))
            ArrowGlyph("▶", litArrow == Arrow.RIGHT, Modifier.align(Alignment.TopEnd).padding(end = maxWidth / 2 - ringRadius + ARROW_INSET, top = ringCenterY - ARROW_SIZE / 2))

            // The single status indicator: what the next gesture lands on (the
            // app on the glasses, or the screen/lock state in the way of it),
            // or the connection problem to fix first. Above the centre line;
            // the tap legend below it, clear of the side arrows.
            val pad = padLine(state, linkStatus)
            Text(
                text = if (holding) "holding" else pad.text,
                style = MaterialTheme.typography.title3,
                color = when {
                    holding -> MaterialTheme.colors.primary
                    pad.tone == StatusTone.GOOD -> MaterialTheme.colors.onSurface
                    else -> pad.tone.color()
                },
                textAlign = TextAlign.Center,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = ringCenterY - 44.dp, start = 60.dp, end = 60.dp),
            )
            Text(
                text = if (prefs.tapZones) "▲▼ tap zones · ● select" else "● select   ●● back   ‒ menu",
                style = MaterialTheme.typography.caption3,
                color = MaterialTheme.colors.onSurfaceVariant,
                textAlign = TextAlign.Center,
                maxLines = 1,
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .padding(top = ringCenterY + 18.dp, start = 56.dp, end = 56.dp),
            )

            Row(
                // Four 36dp buttons need 144dp; at this height the round
                // display's chord is ~186dp wide, so 36dp margins keep every
                // button inside the glass.
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .padding(horizontal = 36.dp, vertical = 26.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                PadButton(icon = R.drawable.ic_assistant, description = "Assistant", onClick = onOpenAssistant)
                PadButton(icon = R.drawable.ic_keyboard, description = "Type into app", onClick = keyboardToApp)
                PadButton(icon = R.drawable.ic_apps, description = "Apps", onClick = onOpenApps)
                PadButton(icon = R.drawable.ic_more, description = "Status and settings", onClick = onOpenStatus)
            }
        }

        NoticeOverlay(notice)
    }
}

/**
 * Run start/stop with the composition AND the activity lifecycle: started on
 * ON_START (or immediately if already started), stopped on ON_STOP and on
 * leaving the composition. A plain DisposableEffect keeps sensors registered
 * while the activity sits stopped-but-cached (palmed screen, back on the watch
 * face), which at gyroscope/accelerometer rates is a real battery drain.
 */
@Composable
private fun WhileStartedEffect(key: Any?, start: () -> Unit, stop: () -> Unit) {
    val lifecycleOwner = LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner, key) {
        val observer = LifecycleEventObserver { _, event ->
            when (event) {
                Lifecycle.Event.ON_START -> start()
                Lifecycle.Event.ON_STOP -> stop()
                else -> Unit
            }
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose {
            lifecycleOwner.lifecycle.removeObserver(observer)
            stop()
        }
    }
}

@Composable
private fun ArrowGlyph(glyph: String, lit: Boolean, modifier: Modifier) {
    Text(
        text = glyph,
        style = MaterialTheme.typography.caption1,
        color = if (lit) MaterialTheme.colors.primary else Color(0xFF6E6E6E),
        textAlign = TextAlign.Center,
        modifier = modifier.size(ARROW_SIZE),
    )
}

@Composable
private fun PadButton(icon: Int, description: String, onClick: () -> Unit) {
    Button(
        onClick = onClick,
        modifier = Modifier.size(36.dp),
        colors = ButtonDefaults.secondaryButtonColors(),
    ) {
        Icon(
            painter = painterResource(icon),
            contentDescription = description,
            modifier = Modifier.size(20.dp),
        )
    }
}
