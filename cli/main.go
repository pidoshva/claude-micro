package main

// claude-micro configurator, Bubble Tea edition. The daemon stays the single
// owner of the HID device; this is a pure client of its localhost control API.
// Screens are a stack: esc pops, enter pushes or acts. The main screen mirrors
// the physical device -- each agent key drawn in its live LED color.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// ---------------------------------------------------------------- styles

var (
	purple    = lipgloss.Color("#8B54F7")
	dimColor  = lipgloss.Color("245")
	greenCol  = lipgloss.Color("#00C853")
	orangeCol = lipgloss.Color("#FF6D00")
	redCol    = lipgloss.Color("#FF5370")

	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(purple)
	dimStyle    = lipgloss.NewStyle().Foreground(dimColor)
	selStyle    = lipgloss.NewStyle().Bold(true)
	cursorStyle = lipgloss.NewStyle().Foreground(purple).Bold(true)
	flashStyle  = lipgloss.NewStyle().Foreground(greenCol)
	warnStyle   = lipgloss.NewStyle().Foreground(orangeCol)
	panelStyle  = lipgloss.NewStyle().
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color("240")).
			Padding(0, 2)
	accentPanel = panelStyle.BorderForeground(purple)
)

// ---------------------------------------------------------------- messages

type stateMsg struct {
	state *DaemonState
	err   error
}
type tickMsg time.Time
type flashMsg struct{}
type identifyMsg struct {
	key string
	err error
}
type testMsg struct{ lines []string }

// ---------------------------------------------------------------- screens

type screenID int

const (
	scMain screenID = iota
	scKeys
	scKeyEditor
	scPaneMode
	scPanePick
	scSkillPick
	scPalette
	scTmux
	scKnob
	scColors
	scColorEdit
	scTest
	scIdentify
	scInput
	scTestResult
)

type screen struct {
	id     screenID
	cursor int
	param  string // key name, status name, input purpose, ...
}

type item struct {
	label, hint, value string
	color              int // -1 = none; else a swatch is drawn
}

// ---------------------------------------------------------------- model

type model struct {
	cfg     Config
	api     *API
	state   *DaemonState
	stack   []screen
	input   textinput.Model
	spin    spinner.Model
	flash   string
	flashOK bool
	testOut []string
	pending map[string]any // in-flight custom action / assignment being built
	cancel  context.CancelFunc
	width   int
}

func initialModel() model {
	cfg, err := LoadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "cannot read ~/.claude/micro/config.json:", err)
		os.Exit(1)
	}
	ti := textinput.New()
	ti.Prompt = cursorStyle.Render("❯ ")
	sp := spinner.New(spinner.WithSpinner(spinner.Dot))
	sp.Style = cursorStyle
	return model{
		cfg:     cfg,
		api:     NewAPI(cfg.GamePort()),
		stack:   []screen{{id: scMain}},
		input:   ti,
		spin:    sp,
		pending: map[string]any{},
	}
}

func (m model) top() *screen { return &m.stack[len(m.stack)-1] }

func (m *model) push(s screen) { m.stack = append(m.stack, s) }
func (m *model) pop() {
	if len(m.stack) > 1 {
		m.stack = m.stack[:len(m.stack)-1]
	}
}
func (m *model) popTo(id screenID) {
	for len(m.stack) > 1 && m.top().id != id {
		m.pop()
	}
}

func (m *model) reload() {
	if cfg, err := LoadConfig(); err == nil {
		m.cfg = cfg
	}
}

func (m *model) setFlash(s string, ok bool) { m.flash, m.flashOK = s, ok }

// ---------------------------------------------------------------- commands

func fetchState(api *API) tea.Cmd {
	return func() tea.Msg {
		s, err := api.State()
		return stateMsg{s, err}
	}
}

func tick() tea.Cmd {
	return tea.Tick(600*time.Millisecond, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func flashLater() tea.Cmd {
	return tea.Tick(1800*time.Millisecond, func(time.Time) tea.Msg { return flashMsg{} })
}

func (m model) Init() tea.Cmd {
	return tea.Batch(fetchState(m.api), tick(), m.spin.Tick)
}

// ---------------------------------------------------------------- update

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {

	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil

	case tickMsg:
		return m, tea.Batch(fetchState(m.api), tick())

	case stateMsg:
		if msg.err == nil {
			m.state = msg.state
		} else {
			m.state = nil
		}
		return m, nil

	case flashMsg:
		m.flash = ""
		return m, nil

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spin, cmd = m.spin.Update(msg)
		return m, cmd

	case identifyMsg:
		if m.cancel != nil {
			m.cancel()
			m.cancel = nil
		}
		m.popTo(scKeys)
		if msg.err != nil {
			m.setFlash("no press seen (or daemon unreachable)", false)
			return m, flashLater()
		}
		for _, k := range KeyNames {
			if k == msg.key {
				m.push(screen{id: scKeyEditor, param: msg.key})
				return m, nil
			}
		}
		m.setFlash("that was "+msg.key+" — a knob/joystick control, not a key", false)
		return m, flashLater()

	case testMsg:
		m.testOut = msg.lines
		m.push(screen{id: scTestResult})
		return m, nil

	case tea.MouseMsg:
		if msg.Action == tea.MouseActionPress {
			s := m.top()
			switch msg.Button {
			case tea.MouseButtonWheelUp:
				m.moveCursor(s, -1)
			case tea.MouseButtonWheelDown:
				m.moveCursor(s, 1)
			}
		}
		return m, nil

	case tea.KeyMsg:
		return m.handleKey(msg)
	}
	return m, nil
}

func (m *model) moveCursor(s *screen, d int) {
	n := len(m.itemsFor(*s))
	if n == 0 {
		return
	}
	s.cursor = ((s.cursor+d)%n + n) % n
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	s := m.top()

	// Text-entry screens route everything into the input widget.
	if s.id == scInput {
		switch msg.String() {
		case "enter":
			return m.submitInput()
		case "esc":
			m.pop()
			return m, nil
		case "ctrl+c":
			return m, tea.Quit
		}
		var cmd tea.Cmd
		m.input, cmd = m.input.Update(msg)
		return m, cmd
	}

	switch msg.String() {
	case "ctrl+c":
		return m, tea.Quit
	case "q":
		if s.id == scMain {
			return m, tea.Quit
		}
		m.pop()
		return m, nil
	case "esc":
		if s.id == scIdentify && m.cancel != nil {
			m.cancel()
			m.cancel = nil
		}
		if s.id == scMain {
			return m, tea.Quit
		}
		m.pop()
		return m, nil
	case "up", "k":
		m.moveCursor(s, -1)
		return m, nil
	case "down", "j":
		m.moveCursor(s, 1)
		return m, nil
	case "enter":
		items := m.itemsFor(*s)
		if len(items) == 0 || s.id == scIdentify || s.id == scTestResult {
			if s.id == scTestResult {
				m.pop()
			}
			return m, nil
		}
		return m.selectItem(*s, items[s.cursor])
	default:
		// number keys jump-select
		if n, err := strconv.Atoi(msg.String()); err == nil && n >= 1 {
			items := m.itemsFor(*s)
			if n <= len(items) {
				s.cursor = n - 1
				return m.selectItem(*s, items[n-1])
			}
		}
		if s.id == scTestResult {
			m.pop()
		}
	}
	return m, nil
}

// ---------------------------------------------------------------- items per screen

func (m model) library() map[string]any { return LoadActions() }

func (m model) itemsFor(s screen) []item {
	switch s.id {
	case scMain:
		return []item{
			{label: "Keys", hint: "assign actions to the 13 keys", value: "keys", color: -1},
			{label: "Tmux", hint: "connect keys to your panes, windows, socket", value: "tmux", color: -1},
			{label: "Knob", hint: "turn & click behavior", value: "knob", color: -1},
			{label: "Colors", hint: "status colors, previewed live on the device", value: "colors", color: -1},
			{label: "Test", hint: "fire any key's action from here", value: "test", color: -1},
			{label: "Quit", value: "quit", color: -1},
		}
	case scKeys:
		lib := m.library()
		items := make([]item, 0, len(KeyNames)+1)
		for i, name := range KeyNames {
			items = append(items, item{
				label: fmt.Sprintf("%2d · %-6s", i+1, name),
				hint:  DescribeKey(m.cfg.Keys()[name], lib),
				value: name, color: -1,
			})
		}
		items = append(items, item{label: "⊙ identify — press a key on the device", value: "__identify", color: -1})
		return items
	case scKeyEditor:
		lib := m.library()
		items := []item{
			{label: "Jump to a tmux pane…", hint: "by position, or pinned to an exact pane", value: "tmux", color: -1},
			{label: "Slash command / prompt…", hint: "a skill or custom text, typed into the focused session", value: "prompt", color: -1},
			{label: "Custom: run a command…", hint: "any shell command, detached or in a tmux window", value: "command", color: -1},
			{label: "Custom: send keys…", hint: "raw keystrokes to the focused pane (C-o, M-t, ...)", value: "keys", color: -1},
		}
		for name, def := range lib {
			if strings.HasPrefix(name, "__") {
				continue
			}
			hint, _ := def.(map[string]any)["description"].(string)
			items = append(items, item{label: "⚡ " + name, hint: hint, value: "__lib:" + name, color: -1})
		}
		items = append(items,
			item{label: "Review", hint: "/code-review on the focused session", value: "review", color: -1},
			item{label: "Approve dialogs", hint: "Enter on the highlighted option", value: "approve", color: -1},
			item{label: "Deny dialogs", hint: "Esc on the dialog", value: "deny", color: -1},
			item{label: "Nothing", hint: "leave the key to the ChatGPT app", value: "none", color: -1},
			item{label: "▸ Test this key now", hint: "fires the real action", value: "__test", color: -1},
		)
		return items
	case scPaneMode:
		return []item{
			{label: "By position…", hint: "Nth pane, sorted session→window→top→left; survives pane churn", value: "position", color: -1},
			{label: "Pin a live pane…", hint: "exact session:window.pane; survives layout reshuffles", value: "pin", color: -1},
		}
	case scPanePick:
		if m.state == nil {
			return nil
		}
		items := make([]item, 0, len(m.state.Panes))
		for _, p := range m.state.Panes {
			hint := p.Command
			if p.HasClaude {
				hint += " · claude ●"
			}
			if p.Active {
				hint += " · (you are here)"
			}
			items = append(items, item{
				label: fmt.Sprintf("#%2d · %-20s", p.Position, p.Coord),
				hint:  hint, value: strconv.Itoa(p.Position - 1), color: -1,
			})
		}
		return items
	case scSkillPick:
		var items []item
		for _, sk := range ListSkills() {
			items = append(items, item{label: "/" + sk.Name, hint: sk.Desc, value: "/" + sk.Name, color: -1})
		}
		items = append(items, item{label: "Custom text…", hint: "anything, typed and submitted", value: "__custom", color: -1})
		return items
	case scTmux:
		target, _ := m.cfg["target"].(string)
		socket, _ := m.cfg["tmuxSocket"].(string)
		if socket == "" {
			socket = "auto"
		}
		return []item{
			{label: "Target mode: " + target, hint: "panes = individual panes · windows = whole windows", value: "mode", color: -1},
			{label: "Socket: " + socket, hint: "auto = learned from sessions; set for a custom -S socket", value: "socket", color: -1},
			{label: "Reassign keys…", hint: "into the Keys editor", value: "keys", color: -1},
		}
	case scKnob:
		knobs, _ := m.cfg["knobs"].(map[string]any)
		left, _ := knobs["left"].(map[string]any)
		turn, _ := left["turn"].(string)
		click, _ := left["click"].(string)
		confirm, _ := left["confirm"].(string)
		if confirm == "" {
			confirm = "session"
		}
		cycle := "4"
		if v, ok := m.cfg["modeCycle"].(float64); ok {
			cycle = strconv.Itoa(int(v))
		}
		return []item{
			{label: "Turn: " + turn, hint: "mode = cycle permission modes · none", value: "turn", color: -1},
			{label: "Click: " + click, hint: "model = open the model picker · none", value: "click", color: -1},
			{label: "Mode cycle length: " + cycle, hint: "permission modes per Shift+Tab lap", value: "modeCycle", color: -1},
			{label: "Model confirm: " + confirm, hint: "session = s · default = Enter (global!)", value: "confirm", color: -1},
		}
	case scColors:
		var items []item
		order := []string{"working", "awaiting-approval", "awaiting-response", "unread", "idle", "error", "empty"}
		style := m.cfg.StatusStyle()
		for _, status := range order {
			st, ok := style[status].(map[string]any)
			if !ok {
				continue
			}
			c := int(st["color"].(float64))
			effect, _ := st["effect"].(string)
			items = append(items, item{label: fmt.Sprintf("%-18s", status), hint: effect, value: status, color: c})
		}
		return items
	case scColorEdit:
		st, _ := m.cfg.StatusStyle()[s.param].(map[string]any)
		c := int(st["color"].(float64))
		effect, _ := st["effect"].(string)
		speed := numOr(st["speed"], 0)
		bright := numOr(st["brightness"], 1)
		return []item{
			{label: fmt.Sprintf("Color: #%06x", c), hint: "palette or free hex", value: "color", color: c},
			{label: "Effect: " + effect, hint: strings.Join(Effects, " / "), value: "effect", color: -1},
			{label: fmt.Sprintf("Speed: %v", speed), hint: "0-1, for animated effects", value: "speed", color: -1},
			{label: fmt.Sprintf("Brightness: %v", bright), hint: "0-1 multiplier", value: "brightness", color: -1},
			{label: "▸ Preview on the device", hint: "lights all six keys for 3s", value: "__preview", color: -1},
		}
	case scPalette:
		palette := []struct {
			name string
			c    int
		}{
			{"codex blue", 0x304FFE}, {"orange", 0xFF6D00}, {"green", 0x00FF4C},
			{"white", 0xFFFFFF}, {"red", 0xFF0033}, {"purple", 0x8B54F7},
			{"deep purple", 0x5B1FD3}, {"cyan", 0x00E5FF}, {"pink", 0xFF4081},
			{"yellow", 0xFFD600}, {"teal", 0x1DE9B6},
		}
		items := make([]item, 0, len(palette)+1)
		for _, p := range palette {
			items = append(items, item{label: fmt.Sprintf("#%06x", p.c), hint: p.name, value: strconv.Itoa(p.c), color: p.c})
		}
		items = append(items, item{label: "Custom hex…", hint: "#RRGGBB, RRGGBB, 0xRRGGBB, or #RGB", value: "__hex", color: -1})
		return items
	case scTest:
		lib := m.library()
		var items []item
		for _, name := range KeyNames {
			entry, ok := m.cfg.Keys()[name].(map[string]any)
			if !ok {
				continue
			}
			if a, _ := entry["action"].(string); a == "none" || (a == "" && entry["use"] == nil) {
				continue
			}
			items = append(items, item{label: name, hint: DescribeKey(entry, lib), value: name, color: -1})
		}
		return items
	}
	return nil
}

func numOr(v any, def float64) float64 {
	if f, ok := v.(float64); ok {
		return f
	}
	return def
}

// ---------------------------------------------------------------- selection

func (m model) selectItem(s screen, it item) (tea.Model, tea.Cmd) {
	switch s.id {

	case scMain:
		switch it.value {
		case "quit":
			return m, tea.Quit
		case "keys":
			m.reload()
			m.push(screen{id: scKeys})
		case "tmux":
			m.reload()
			m.push(screen{id: scTmux})
		case "knob":
			m.reload()
			m.push(screen{id: scKnob})
		case "colors":
			m.reload()
			m.push(screen{id: scColors})
		case "test":
			m.reload()
			m.push(screen{id: scTest})
		}
		return m, nil

	case scKeys:
		if it.value == "__identify" {
			ctx, cancel := context.WithCancel(context.Background())
			m.cancel = cancel
			m.push(screen{id: scIdentify})
			api := m.api
			return m, tea.Batch(m.spin.Tick, func() tea.Msg {
				k, err := api.NextPress(ctx)
				return identifyMsg{k, err}
			})
		}
		m.push(screen{id: scKeyEditor, param: it.value})
		return m, nil

	case scKeyEditor:
		return m.keyEditorSelect(s.param, it.value)

	case scPaneMode:
		m.pending["paneMode"] = it.value
		m.push(screen{id: scPanePick})
		return m, nil

	case scPanePick:
		idx, _ := strconv.Atoi(it.value)
		key, _ := m.pending["key"].(string)
		if m.pending["paneMode"] == "pin" && m.state != nil {
			m.cfg.SetKey(key, map[string]any{"action": "tmux", "target": m.state.Panes[idx].Coord})
		} else {
			m.cfg.SetKey(key, map[string]any{"action": "tmux", "index": idx})
		}
		return m.saveAndBack(key)

	case scSkillPick:
		key, _ := m.pending["key"].(string)
		if it.value == "__custom" {
			return m.openInput("Text to type into the session:", "", "promptText")
		}
		label := strings.TrimPrefix(strings.Fields(it.value)[0], "/")
		m.cfg.SetKey(key, map[string]any{"action": "prompt", "label": label, "text": it.value})
		return m.saveAndBack(key)

	case scTmux:
		switch it.value {
		case "mode":
			target, _ := m.cfg["target"].(string)
			if target == "panes" {
				m.cfg["target"] = "windows"
			} else {
				m.cfg["target"] = "panes"
			}
			m.cfg.Save()
			m.setFlash("saved (daemon hot-reloads)", true)
			return m, flashLater()
		case "socket":
			cur, _ := m.cfg["tmuxSocket"].(string)
			return m.openInput("Socket path (empty = auto):", cur, "socket")
		case "keys":
			m.push(screen{id: scKeys})
		}
		return m, nil

	case scKnob:
		knobs, _ := m.cfg["knobs"].(map[string]any)
		left, _ := knobs["left"].(map[string]any)
		switch it.value {
		case "turn":
			left["turn"] = toggle(left["turn"], "mode", "none")
		case "click":
			left["click"] = toggle(left["click"], "model", "none")
		case "confirm":
			cur, _ := left["confirm"].(string)
			if cur == "" {
				cur = "session"
			}
			left["confirm"] = toggle(cur, "session", "default")
		case "modeCycle":
			cycle := "4"
			if v, ok := m.cfg["modeCycle"].(float64); ok {
				cycle = strconv.Itoa(int(v))
			}
			return m.openInput("Modes per lap (count them with Shift+Tab):", cycle, "modeCycle")
		}
		m.cfg.Save()
		m.setFlash("saved (daemon hot-reloads)", true)
		return m, flashLater()

	case scColors:
		m.push(screen{id: scColorEdit, param: it.value})
		return m, nil

	case scColorEdit:
		st, _ := m.cfg.StatusStyle()[s.param].(map[string]any)
		switch it.value {
		case "color":
			m.push(screen{id: scPalette, param: s.param})
			return m, nil
		case "effect":
			cur, _ := st["effect"].(string)
			st["effect"] = nextEffect(cur)
			m.cfg.Save()
			return m.previewStatus(s.param, "effect: "+st["effect"].(string))
		case "speed":
			return m.openInput("Speed (0-1):", fmt.Sprintf("%v", numOr(st["speed"], 0)), "speed")
		case "brightness":
			return m.openInput("Brightness (0-1):", fmt.Sprintf("%v", numOr(st["brightness"], 1)), "brightness")
		case "__preview":
			return m.previewStatus(s.param, "previewing on the device…")
		}
		return m, nil

	case scPalette:
		if it.value == "__hex" {
			st, _ := m.cfg.StatusStyle()[s.param].(map[string]any)
			cur := fmt.Sprintf("%06x", int(st["color"].(float64)))
			return m.openInput("Hex color (#RRGGBB, RRGGBB, 0xRRGGBB, #RGB):", cur, "hex")
		}
		c, _ := strconv.Atoi(it.value)
		st, _ := m.cfg.StatusStyle()[s.param].(map[string]any)
		st["color"] = float64(c)
		m.cfg.Save()
		m.pop()
		return m.previewStatus(s.param, fmt.Sprintf("saved #%06x + previewing", c))

	case scTest:
		return m.fireTest(it.value)
	}
	return m, nil
}

func toggle(v any, a, b string) string {
	if s, _ := v.(string); s == a {
		return b
	}
	return a
}

func nextEffect(cur string) string {
	for i, e := range Effects {
		if e == cur {
			return Effects[(i+1)%len(Effects)]
		}
	}
	return Effects[0]
}

func (m model) keyEditorSelect(key, value string) (tea.Model, tea.Cmd) {
	m.pending = map[string]any{"key": key}
	switch value {
	case "tmux":
		m.push(screen{id: scPaneMode})
		return m, nil
	case "prompt":
		m.push(screen{id: scSkillPick})
		return m, nil
	case "command":
		return m.openInput("Shell command ($MICRO_PANE, $MICRO_PANE_PATH, $MICRO_SESSION, $MICRO_KEY are set):", "", "customRun")
	case "keys":
		return m.openInput("Keys in tmux send-keys syntax, space-separated (e.g. C-o):", "", "customKeys")
	case "review":
		m.cfg.SetKey(key, map[string]any{"action": "review", "effort": "high"})
		return m.saveAndBack(key)
	case "approve", "deny":
		m.cfg.SetKey(key, map[string]any{"action": value, "cooldownMs": 700})
		return m.saveAndBack(key)
	case "none":
		m.cfg.SetKey(key, map[string]any{"action": "none"})
		return m.saveAndBack(key)
	case "__test":
		return m.fireTest(key)
	}
	if strings.HasPrefix(value, "__lib:") {
		m.cfg.SetKey(key, map[string]any{"use": strings.TrimPrefix(value, "__lib:")})
		return m.saveAndBack(key)
	}
	return m, nil
}

func (m model) saveAndBack(key string) (tea.Model, tea.Cmd) {
	m.cfg.Save()
	m.popTo(scKeys)
	m.setFlash("saved — "+key+" is now: "+DescribeKey(m.cfg.Keys()[key], m.library())+" (daemon hot-reloads)", true)
	return m, flashLater()
}

func (m model) previewStatus(status, note string) (tea.Model, tea.Cmd) {
	st, _ := m.cfg.StatusStyle()[status].(map[string]any)
	itemP := PreviewItem{
		Color:      int(st["color"].(float64)),
		Effect:     str(st["effect"]),
		Speed:      numOr(st["speed"], 0),
		Brightness: numOr(st["brightness"], 1),
	}
	api := m.api
	m.setFlash(note, true)
	return m, tea.Batch(flashLater(), func() tea.Msg {
		api.Preview(itemP, 3000)
		return nil
	})
}

func str(v any) string { s, _ := v.(string); return s }

func (m model) fireTest(key string) (tea.Model, tea.Cmd) {
	api := m.api
	return m, func() tea.Msg {
		if err := api.Press(key); err != nil {
			return testMsg{[]string{"daemon unreachable — cannot test"}}
		}
		time.Sleep(1200 * time.Millisecond)
		lines := []string{"pressed " + key + " — daemon log says:"}
		if data, err := os.ReadFile(filepath.Join(microDir, "daemon.log")); err == nil {
			all := strings.Split(strings.TrimSpace(string(data)), "\n")
			if len(all) > 3 {
				all = all[len(all)-3:]
			}
			for _, l := range all {
				lines = append(lines, truncate(l, 100))
			}
		}
		return testMsg{lines}
	}
}

// ---------------------------------------------------------------- inputs

func (m model) openInput(prompt, initial, purpose string) (tea.Model, tea.Cmd) {
	m.input.SetValue(initial)
	m.input.Focus()
	m.input.CursorEnd()
	m.push(screen{id: scInput, param: purpose + "\x00" + prompt})
	return m, textinput.Blink
}

func (m model) submitInput() (tea.Model, tea.Cmd) {
	parts := strings.SplitN(m.top().param, "\x00", 2)
	purpose := parts[0]
	value := strings.TrimSpace(m.input.Value())
	m.pop()

	key, _ := m.pending["key"].(string)
	switch purpose {
	case "promptText":
		if value == "" {
			return m, nil
		}
		label := "prompt"
		if strings.HasPrefix(value, "/") {
			label = strings.TrimPrefix(strings.Fields(value)[0], "/")
		}
		m.cfg.SetKey(key, map[string]any{"action": "prompt", "label": label, "text": value})
		return m.saveAndBack(key)
	case "customRun":
		if value == "" {
			return m, nil
		}
		m.pending["run"] = value
		return m.openInput("Label (shows on the device map):", filepath.Base(strings.Fields(value)[0]), "customRunLabel")
	case "customRunLabel":
		run, _ := m.pending["run"].(string)
		m.cfg.SetKey(key, map[string]any{"action": "command", "label": value, "run": run})
		return m.saveAndBack(key)
	case "customKeys":
		if value == "" {
			return m, nil
		}
		keys := strings.Fields(value)
		anyKeys := make([]any, len(keys))
		for i, k := range keys {
			anyKeys[i] = k
		}
		m.cfg.SetKey(key, map[string]any{"action": "keys", "label": keys[0], "keys": anyKeys})
		return m.saveAndBack(key)
	case "socket":
		if value == "" {
			m.cfg["tmuxSocket"] = nil
		} else {
			m.cfg["tmuxSocket"] = value
		}
		m.cfg.Save()
		m.setFlash("saved (daemon hot-reloads)", true)
		return m, flashLater()
	case "modeCycle":
		if n, err := strconv.Atoi(value); err == nil && n > 1 {
			m.cfg["modeCycle"] = float64(n)
			m.cfg.Save()
			m.setFlash("saved (daemon hot-reloads)", true)
		}
		return m, flashLater()
	case "hex":
		c, ok := parseHex(value)
		status := m.top().param
		if !ok {
			m.setFlash("\""+value+"\" is not a color", false)
			return m, flashLater()
		}
		st, _ := m.cfg.StatusStyle()[status].(map[string]any)
		st["color"] = float64(c)
		m.cfg.Save()
		m.popTo(scColorEdit)
		return m.previewStatus(status, fmt.Sprintf("saved #%06x + previewing", c))
	case "speed", "brightness":
		status := m.top().param
		if f, err := strconv.ParseFloat(value, 64); err == nil {
			st, _ := m.cfg.StatusStyle()[status].(map[string]any)
			st[purpose] = clamp01(f)
			m.cfg.Save()
			return m.previewStatus(status, "saved + previewing")
		}
		return m, nil
	}
	return m, nil
}

func clamp01(f float64) float64 {
	if f < 0 {
		return 0
	}
	if f > 1 {
		return 1
	}
	return f
}

func parseHex(s string) (int, bool) {
	t := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(s), "#"), "0x")
	t = strings.TrimPrefix(t, "0X")
	if len(t) == 3 {
		t = string([]byte{t[0], t[0], t[1], t[1], t[2], t[2]})
	}
	if len(t) != 6 {
		return 0, false
	}
	n, err := strconv.ParseInt(t, 16, 64)
	if err != nil {
		return 0, false
	}
	return int(n), true
}

// ---------------------------------------------------------------- view

func swatch(c int) string {
	return lipgloss.NewStyle().Foreground(lipgloss.Color(fmt.Sprintf("#%06x", c))).Render("██")
}

func (m model) deviceMap() string {
	if m.state == nil {
		return dimStyle.Render("(daemon unreachable — start it and this map goes live)")
	}
	style := m.cfg.StatusStyle()
	bySlot := map[string]Slot{}
	for _, s := range m.state.Slots {
		bySlot[s.Name] = s
	}
	var blocks []string
	for _, name := range KeyNames[:6] {
		slot, ok := bySlot[name]
		if !ok || slot.Status == nil {
			blocks = append(blocks, dimStyle.Render("▒▒"))
			continue
		}
		st, _ := style[*slot.Status].(map[string]any)
		if st == nil {
			blocks = append(blocks, dimStyle.Render("▒▒"))
			continue
		}
		c := int(st["color"].(float64))
		b := swatch(c)
		if *slot.Status == "empty" {
			b = dimStyle.Render("··")
		}
		blocks = append(blocks, b)
	}
	var actions []string
	lib := m.library()
	for i, name := range KeyNames[6:] {
		entry, _ := m.cfg.Keys()[name].(map[string]any)
		label := "·"
		if entry != nil {
			if l, _ := entry["label"].(string); l != "" {
				label = l
			} else if a, _ := entry["action"].(string); a != "" && a != "none" {
				label = a
			} else if u, _ := entry["use"].(string); u != "" {
				label = u
			}
		}
		_ = lib
		if label == "·" {
			actions = append(actions, dimStyle.Render(strconv.Itoa(i+7)+"·"))
		} else {
			actions = append(actions, dimStyle.Render(strconv.Itoa(i+7)+"·")+truncate(label, 9))
		}
	}
	rows := []string{
		strings.Join(blocks, " ") + "    " + cursorStyle.Render("◉") + " knob   " + cursorStyle.Render("✛") + " joystick",
		dimStyle.Render("1  2  3  4  5  6"),
		strings.Join(actions, "  "),
	}
	return strings.Join(rows, "\n")
}

func (m model) header() string {
	status := warnStyle.Render("daemon NOT RUNNING") + dimStyle.Render(" · edits still save")
	if m.state != nil {
		dev := warnStyle.Render("asleep/away")
		if m.state.Connected {
			dev = flashStyle.Render("connected")
		}
		status = flashStyle.Render("daemon up") + dimStyle.Render(" · device ") + dev
	}
	return titleStyle.Render("claude-micro") + " configurator   " + status
}

func (m model) titleFor(s screen) string {
	switch s.id {
	case scKeys:
		return "Keys"
	case scKeyEditor:
		return s.param + " — currently: " + DescribeKey(m.cfg.Keys()[s.param], m.library())
	case scPaneMode:
		return "How should this key find its pane?"
	case scPanePick:
		return "Pick a live pane"
	case scSkillPick:
		return "What should it type?"
	case scTmux:
		return "Tmux"
	case scKnob:
		return "Knob"
	case scColors:
		return "Status colors"
	case scColorEdit:
		return s.param
	case scPalette:
		return "Pick a color"
	case scTest:
		return "Test a key (fires its real action)"
	}
	return ""
}

func (m model) View() string {
	s := m.top()
	var body strings.Builder

	switch s.id {
	case scIdentify:
		body.WriteString(m.spin.View() + " " + warnStyle.Render("press any key on the Micro…") +
			dimStyle.Render("  (30s · esc cancels)"))
	case scTestResult:
		for i, l := range m.testOut {
			if i == 0 {
				body.WriteString(flashStyle.Render(l) + "\n")
			} else {
				body.WriteString(dimStyle.Render(l) + "\n")
			}
		}
		body.WriteString("\n" + dimStyle.Render("any key to go back"))
	case scInput:
		parts := strings.SplitN(s.param, "\x00", 2)
		prompt := parts[len(parts)-1]
		body.WriteString(prompt + "\n\n" + m.input.View())
		if strings.HasPrefix(parts[0], "hex") {
			if c, ok := parseHex(m.input.Value()); ok {
				body.WriteString("  " + swatch(c) + fmt.Sprintf(" #%06x", c))
			} else {
				body.WriteString("  " + dimStyle.Render("…"))
			}
		}
	default:
		items := m.itemsFor(*s)
		if title := m.titleFor(*s); title != "" {
			body.WriteString(selStyle.Render(title) + "\n\n")
		}
		for i, it := range items {
			marker := "  "
			label := it.label
			if i == s.cursor {
				marker = cursorStyle.Render("❯ ")
				label = selStyle.Render(label)
			}
			line := "  " + marker
			if it.color >= 0 {
				line += swatch(it.color) + " "
			}
			line += label
			if it.hint != "" {
				line += "  " + dimStyle.Render(it.hint)
			}
			body.WriteString(line + "\n")
		}
	}

	var out strings.Builder
	out.WriteString(m.header() + "\n")

	if s.id == scMain {
		mapPanel := accentPanel.Render(m.deviceMap())
		menuPanel := panelStyle.Render(strings.TrimRight(body.String(), "\n"))
		out.WriteString(lipgloss.JoinVertical(lipgloss.Left, mapPanel, menuPanel))
	} else {
		out.WriteString(panelStyle.Render(strings.TrimRight(body.String(), "\n")))
	}

	out.WriteString("\n")
	if m.flash != "" {
		st := flashStyle
		if !m.flashOK {
			st = warnStyle
		}
		out.WriteString(st.Render("  "+m.flash) + "\n")
	}
	out.WriteString(dimStyle.Render("  ↑↓/wheel move · enter select · esc back · q quit") + "\n")
	return out.String()
}

// ---------------------------------------------------------------- main

func main() {
	p := tea.NewProgram(initialModel(), tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
