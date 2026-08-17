package main

import (
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
)

func TestGridScreensRender(t *testing.T) {
	m := initialModel()

	// Keys map renders and navigates.
	m.stack = []screen{{id: scMain}, {id: scKeys}}
	if v := m.View(); !strings.Contains(v, "Keys — pick a cap") {
		t.Fatalf("keys view missing title:\n%s", v)
	}
	for _, k := range []string{"right", "down", "left", "up", "l", "j"} {
		mm, _ := m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(k)})
		if k == "right" || k == "down" || k == "left" || k == "up" {
			mm, _ = m.handleKey(keyFor(k))
		}
		m = mm.(model)
		_ = m.View()
	}
	mm, _ := m.handleKey(tea.KeyMsg{Type: tea.KeyEnter})
	m = mm.(model)
	if m.top().id != scKeyEditor {
		t.Fatalf("enter on keys map should open editor, got screen %d", m.top().id)
	}

	// Palette grid renders, navigates, and hex short-cut opens input.
	m = initialModel()
	m.stack = []screen{{id: scMain}, {id: scColors}, {id: scColorEdit, param: "working"}, {id: scPalette, param: "working", cursor: paletteCursorFor(0x304FFE)}}
	if v := m.View(); !strings.Contains(v, "Pick a color — working") {
		t.Fatalf("palette view missing title:\n%s", v)
	}
	for _, k := range []string{"left", "right", "up", "down"} {
		mm, _ := m.handleKey(keyFor(k))
		m = mm.(model)
		_ = m.View()
	}
	mm, _ = m.handleKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune("x")})
	m = mm.(model)
	if m.top().id != scInput {
		t.Fatalf("x on palette should open hex input, got screen %d", m.top().id)
	}

	// Device map with muted, reassigned agent keys renders without panic.
	m = initialModel()
	m.state = &DaemonState{Connected: true}
	_ = m.deviceMap()

	if len(paletteGrid()) < 2 || len(paletteGrid()[0]) != palCols {
		t.Fatal("palette grid has wrong shape")
	}
}

func keyFor(name string) tea.KeyMsg {
	switch name {
	case "left":
		return tea.KeyMsg{Type: tea.KeyLeft}
	case "right":
		return tea.KeyMsg{Type: tea.KeyRight}
	case "up":
		return tea.KeyMsg{Type: tea.KeyUp}
	case "down":
		return tea.KeyMsg{Type: tea.KeyDown}
	}
	return tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune(name)}
}
