import AppKit
import Foundation

struct UsageRow: Decodable {
    let label: String
    let used: Double?
    let remaining: String?
    let stale: Bool
    /// The worker's pace level: "ok", "warn" or "high".
    let level: String?
}

struct TokenTotals: Decodable {
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
}

/// A newer cc-remote build in its source checkout, and the update the button runs.
struct UpdateInfo: Decodable {
    let current: String
    let latest: String
    /// "idle", "running", "done", "partial" (cc-remote updated, the plugin not) or "failed".
    let state: String
    let message: String?
}

struct UsageState: Decodable {
    let rows: [UsageRow]
    let tokens: TokenTotals?
    let querying: Bool
    let queryFailed: Bool
    /// The central server, said beside the refresh button as Orca's panel says "all agents".
    let host: String?
    let update: UpdateInfo?
}

func rgb(_ hex: UInt32) -> NSColor {
    NSColor(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
}

/// The remote status line's green, amber and red (xterm 114, 221, 203) on a dark background; a
/// deeper shade of each on a light one, where the pale ones would barely show.
func paceColour(_ level: String?) -> NSColor {
    let dark: UInt32, light: UInt32
    switch level {
    case "high": (dark, light) = (0xFF5F5F, 0xE5484D)
    case "warn": (dark, light) = (0xFFD75F, 0xE0A800)
    default: (dark, light) = (0x87D787, 0x46A758)
    }
    return NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? rgb(dark) : rgb(light)
    }
}

final class Meter: NSView {
    let used: Double
    let level: String?
    init(frame: NSRect, used: Double, level: String?) {
        self.used = min(100, max(0, used))
        self.level = level
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityValue(self.used)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }
    override func draw(_ dirtyRect: NSRect) {
        // A faint track: withAlphaComponent replaces a colour's alpha, so start from an opaque label colour.
        NSColor.labelColor.withAlphaComponent(0.08).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
        guard used > 0 else { return }
        let width = max(bounds.height, bounds.width * used / 100)
        paceColour(level).setFill()
        NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: width, height: bounds.height), xRadius: bounds.height / 2, yRadius: bounds.height / 2).fill()
    }
}

/// A button that takes the click which also brings the panel forward.
class FirstMouseButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

/// The refresh button of Orca's usage panel: 20 points square, Lucide's refresh-cw at 12 points in
/// the secondary colour, and while the pointer is over it a rounded backdrop and the full colour.
final class RefreshButton: FirstMouseButton {
    convenience init(help: String, target: AnyObject, action: Selector) {
        self.init(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
        title = ""
        imagePosition = .noImage
        isBordered = false
        bezelStyle = .regularSquare
        self.target = target
        self.action = action
        setAccessibilityLabel(help)
        wantsLayer = true
        drawIcon()
    }

    /// Lucide's refresh-cw (ISC License, https://lucide.dev), the icon Orca's panel turns: on a 24-unit
    /// grid, y down, both arcs centred on (12, 12). Orca turns it about the middle of its box, the
    /// arcs' centre, so the circle stays put and only the arrowheads go round.
    private static let refreshCw: CGPath = {
        let path = CGMutablePath()
        /// An SVG arc, the small one with sweep 1 (clockwise on a y-down grid), to `end`.
        func arc(to end: CGPoint, radius r: CGFloat) {
            let start = path.currentPoint
            let dx = end.x - start.x, dy = end.y - start.y, chord = hypot(dx, dy)
            let h = sqrt(max(0, r * r - chord * chord / 4))
            // Clockwise on screen: the centre is to the right of the way the arc goes.
            let centre = CGPoint(x: (start.x + end.x) / 2 - dy / chord * h, y: (start.y + end.y) / 2 + dx / chord * h)
            path.addArc(center: centre, radius: r, startAngle: atan2(start.y - centre.y, start.x - centre.x), endAngle: atan2(end.y - centre.y, end.x - centre.x), clockwise: false)
        }
        // M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8
        path.move(to: CGPoint(x: 3, y: 12))
        arc(to: CGPoint(x: 12, y: 3), radius: 9)
        arc(to: CGPoint(x: 18.74, y: 5.74), radius: 9.75)
        path.addLine(to: CGPoint(x: 21, y: 8))
        // M21 3v5h-5
        path.move(to: CGPoint(x: 21, y: 3))
        path.addLine(to: CGPoint(x: 21, y: 8))
        path.addLine(to: CGPoint(x: 16, y: 8))
        // M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16
        path.move(to: CGPoint(x: 21, y: 12))
        arc(to: CGPoint(x: 12, y: 21), radius: 9)
        arc(to: CGPoint(x: 5.26, y: 18.26), radius: 9.75)
        path.addLine(to: CGPoint(x: 3, y: 16))
        // M8 16H3v5
        path.move(to: CGPoint(x: 8, y: 16))
        path.addLine(to: CGPoint(x: 3, y: 16))
        path.addLine(to: CGPoint(x: 3, y: 21))
        return path
    }()

    /// The icon: one vector layer, the same at rest and while it turns.
    private let iconLayer = CAShapeLayer()

    var hovered = false {
        didSet {
            drawIcon()
            needsDisplay = true
        }
    }

    /// Turns the icon clockwise, a turn a second, as Orca's `animate-spin` does: the refresh button,
    /// while usage is being refreshed. A layer animation, which the window server runs on its own.
    var spinning = false {
        didSet {
            guard spinning != oldValue else { return }
            if spinning { startSpinning() } else { iconLayer.removeAnimation(forKey: "spin") }
        }
    }

    // The panel never becomes the active window, so tracking has to run regardless.
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        drawIcon()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        drawIcon()
    }

    /// The icon at 12 points, as Orca's panel sizes it (strokes 2 units wide, 1 point), in the
    /// secondary colour or the full one under the pointer, for this view's light or dark appearance.
    private func drawIcon() {
        guard let layer else { return }
        var colour: CGColor?
        effectiveAppearance.performAsCurrentDrawingAppearance {
            colour = (hovered ? NSColor.labelColor : .secondaryLabelColor).cgColor
        }
        let size: CGFloat = 12, unit = size / 24
        // The grid is y down, as a flipped layer's sublayers are; otherwise turned the right way up.
        var grid = layer.contentsAreFlipped() ? CGAffineTransform(scaleX: unit, y: unit) : CGAffineTransform(a: unit, b: 0, c: 0, d: -unit, tx: 0, ty: size)
        // A new colour at once, not a layer's implicit fade.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        iconLayer.path = RefreshButton.refreshCw.copy(using: &grid)
        iconLayer.fillColor = nil
        iconLayer.strokeColor = colour
        iconLayer.lineWidth = 2 * unit
        iconLayer.lineCap = .round
        iconLayer.lineJoin = .round
        iconLayer.contentsScale = window?.backingScaleFactor ?? NSScreen.main?.backingScaleFactor ?? 2
        // Its middle, the arcs' centre, on the button's: the point it turns about.
        iconLayer.bounds = CGRect(x: 0, y: 0, width: size, height: size)
        iconLayer.position = CGPoint(x: bounds.midX, y: bounds.midY)
        if iconLayer.superlayer == nil { layer.addSublayer(iconLayer) }
        CATransaction.commit()
    }

    private func startSpinning() {
        let turn = CABasicAnimation(keyPath: "transform.rotation.z")
        turn.fromValue = 0
        // Clockwise: a negative angle, unless the layer's geometry is flipped as its view is.
        turn.toValue = (layer?.contentsAreFlipped() ?? isFlipped ? 1 : -1) * 2 * CGFloat.pi
        turn.duration = 1
        turn.repeatCount = .infinity
        turn.timingFunction = CAMediaTimingFunction(name: .linear)
        // At the display's own rate, as a browser runs a CSS animation: 120 Hz on ProMotion, not 60.
        if #available(macOS 12.0, *) { turn.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120) }
        // In step with the clock, so a button a render puts in its place carries on the same turn.
        turn.timeOffset = CACurrentMediaTime().truncatingRemainder(dividingBy: 1)
        iconLayer.add(turn, forKey: "spin")
    }

    override func draw(_ dirtyRect: NSRect) {
        if hovered {
            NSColor.labelColor.withAlphaComponent(0.1).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        }
        super.draw(dirtyRect)
    }
}

final class UsagePanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
}

final class Popover: NSObject, NSWindowDelegate {
    let width: CGFloat = 330
    let panel: UsagePanel
    let anchor: NSPoint
    let screen: NSScreen
    var outsideMonitor: Any?
    var bytes = Data()

    override init() {
        let anchorPoint = NSEvent.mouseLocation
        anchor = anchorPoint
        screen = NSScreen.screens.first(where: { $0.frame.contains(anchorPoint) }) ?? NSScreen.main ?? NSScreen.screens[0]
        panel = UsagePanel(contentRect: NSRect(x: 0, y: 0, width: 330, height: 250), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.delegate = self
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .transient]
        render(UsageState(rows: [], tokens: nil, querying: true, queryFailed: false, host: nil, update: nil))
        panel.orderFrontRegardless()
        outsideMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] _ in
            guard let self = self else { return }
            // Gone at once, before the process has finished quitting.
            if !self.panel.frame.contains(NSEvent.mouseLocation) { DispatchQueue.main.async { self.panel.orderOut(nil); NSApp.terminate(nil) } }
        }
        FileHandle.standardInput.readabilityHandler = { [weak self] file in
            let next = file.availableData
            guard !next.isEmpty else { DispatchQueue.main.async { NSApp.terminate(nil) }; return }
            DispatchQueue.main.async { self?.receive(next) }
        }
    }

    func receive(_ data: Data) {
        bytes.append(data)
        if bytes.count > 131_072 { bytes.removeAll(); return }
        while let newline = bytes.firstIndex(of: 10) {
            let line = bytes.prefix(upTo: newline)
            bytes.removeSubrange(...newline)
            if let value = try? JSONDecoder().decode(UsageState.self, from: Data(line)) { render(value) }
        }
    }

    func label(_ text: String, size: CGFloat, weight: NSFont.Weight = .regular, colour: NSColor = .labelColor) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size, weight: weight)
        field.textColor = colour
        field.lineBreakMode = .byTruncatingTail
        return field
    }


    func render(_ state: UsageState) {
        let rows = Array(state.rows.prefix(12))
        let banner: CGFloat = state.update == nil ? 0 : 52
        let bodyHeight = CGFloat(max(42, rows.count * 56 + (state.tokens == nil ? 0 : 42))) + banner
        let height = min(450, bodyHeight + 58)
        let visible = screen.visibleFrame.insetBy(dx: 8, dy: 8)
        let x = min(max(anchor.x - width / 2, visible.minX), max(visible.minX, visible.maxX - width))
        let y = anchor.y + height + 12 <= visible.maxY ? max(visible.minY, anchor.y + 12) : max(visible.minY, anchor.y - height - 12)
        panel.setFrame(NSRect(x: x, y: y, width: width, height: height), display: false)

        let background = NSView(frame: NSRect(x: 0, y: 0, width: width, height: height))
        background.wantsLayer = true
        background.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        background.layer?.cornerRadius = 12
        background.layer?.masksToBounds = true
        background.layer?.borderWidth = 0.5
        background.layer?.borderColor = NSColor.separatorColor.cgColor
        panel.contentView = background

        let title = label("远程 Claude 用量", size: 13, weight: .semibold)
        title.frame = NSRect(x: 14, y: height - 31, width: 200, height: 17)
        background.addSubview(title)
        // Beside the refresh button, as in Orca's usage panel: the server, or that a refresh failed.
        // A refresh in progress only turns the icon.
        let failed = state.queryFailed && !state.querying
        let note = label(failed ? "更新失败" : state.host ?? "", size: 11, colour: failed ? .systemOrange : .secondaryLabelColor)
        note.alignment = .right
        note.frame = NSRect(x: width - 192, y: height - 30, width: 150, height: 15)
        background.addSubview(note)
        // No close button: a click anywhere else closes it.
        let refresh = RefreshButton(help: "刷新用量", target: self, action: #selector(refreshPressed))
        refresh.setFrameOrigin(NSPoint(x: width - 34, y: height - 32))
        refresh.spinning = state.querying
        background.addSubview(refresh)
        let rule = NSBox(frame: NSRect(x: 0, y: height - 41, width: width, height: 1))
        rule.boxType = .separator
        background.addSubview(rule)

        let scroll = NSScrollView(frame: NSRect(x: 0, y: 8, width: width, height: height - 50))
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = bodyHeight > scroll.frame.height
        scroll.autohidesScrollers = true
        let body = NSView(frame: NSRect(x: 0, y: 0, width: width, height: bodyHeight))
        scroll.documentView = body
        background.addSubview(scroll)

        if let update = state.update {
            let top = bodyHeight - 4
            let failed = update.state == "failed" || update.state == "partial"
            let heading: String
            switch update.state {
            case "running": heading = "正在更新 cc-remote…"
            case "done": heading = "cc-remote 已更新"
            case "partial": heading = "cc-remote 已更新，用量插件未更新"
            case "failed": heading = "cc-remote 更新失败"
            default: heading = "cc-remote 有新版本"
            }
            let title = label(heading, size: 12, weight: .medium, colour: failed ? .systemOrange : .labelColor)
            title.frame = NSRect(x: 16, y: top - 18, width: width - 112, height: 16)
            body.addSubview(title)
            let detail = label(update.message ?? "已安装 \(update.current) → 源码 \(update.latest)", size: 10, colour: .secondaryLabelColor)
            detail.frame = NSRect(x: 16, y: top - 34, width: width - 112, height: 14)
            body.addSubview(detail)
            if update.state == "idle" || failed {
                let button = FirstMouseButton(title: failed ? "重试" : "更新", target: self, action: #selector(updatePressed))
                button.bezelStyle = .rounded
                button.controlSize = .small
                button.frame = NSRect(x: width - 88, y: top - 32, width: 72, height: 26)
                body.addSubview(button)
            }
            let separator = NSBox(frame: NSRect(x: 16, y: top - 46, width: width - 32, height: 1))
            separator.boxType = .separator
            body.addSubview(separator)
        }

        for (index, row) in rows.enumerated() {
            let top = bodyHeight - banner - CGFloat(index * 56)
            let name = label(row.label, size: 12, weight: .medium)
            name.frame = NSRect(x: 16, y: top - 18, width: 190, height: 16)
            body.addSubview(name)
            let percentage = label(row.used.map { String(format: "%g%%", $0) } ?? "暂无数据", size: 12, weight: .medium)
            percentage.alignment = .right
            percentage.frame = NSRect(x: width - 105, y: top - 18, width: 89, height: 16)
            body.addSubview(percentage)
            if let used = row.used {
                let meter = Meter(frame: NSRect(x: 16, y: top - 30, width: width - 32, height: 4), used: used, level: row.level)
                meter.setAccessibilityLabel("\(row.label)已用")
                body.addSubview(meter)
            }
            let reset = row.remaining.map { "\($0) 后重置" } ?? (row.stale ? "数据已过期" : "")
            let detail = label(reset + (row.stale && row.remaining != nil ? " · 数据可能过期" : ""), size: 10, colour: .secondaryLabelColor)
            detail.frame = NSRect(x: 16, y: top - 48, width: width - 32, height: 14)
            body.addSubview(detail)
        }

        if let tokens = state.tokens {
            let separator = NSBox(frame: NSRect(x: 16, y: 34, width: width - 32, height: 1))
            separator.boxType = .separator
            body.addSubview(separator)
            let first = label("会话 Token：输入 \(tokens.input) · 输出 \(tokens.output)", size: 10, colour: .secondaryLabelColor)
            first.frame = NSRect(x: 16, y: 18, width: width - 32, height: 14)
            body.addSubview(first)
            let second = label("缓存读取 \(tokens.cacheRead) · 写入 \(tokens.cacheWrite)", size: 10, colour: .secondaryLabelColor)
            second.frame = NSRect(x: 16, y: 4, width: width - 32, height: 14)
            body.addSubview(second)
        }
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, bodyHeight - scroll.contentView.bounds.height)))
        scroll.reflectScrolledClipView(scroll.contentView)
        panel.displayIfNeeded()
    }

    @objc func refreshPressed() {
        FileHandle.standardOutput.write(Data("{\"action\":\"refresh\"}\n".utf8))
    }
    @objc func updatePressed() {
        FileHandle.standardOutput.write(Data("{\"action\":\"update\"}\n".utf8))
    }
    func windowWillClose(_ notification: Notification) { NSApp.terminate(nil) }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let popover = Popover()
app.run()
withExtendedLifetime(popover) {}
