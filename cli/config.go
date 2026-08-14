package main

// config.json and actions.json live in ~/.claude/micro and are hot-reloaded
// by the daemon on save -- there is no apply step. Both are read into generic
// maps so fields this CLI doesn't know about survive a round-trip untouched
// (Go's json.MarshalIndent orders map keys alphabetically, so saves are
// deterministic even though field order isn't preserved).

import (
	"encoding/json"
	"strconv"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var microDir = func() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".claude", "micro")
}()

var KeyNames = []string{
	"AG00", "AG01", "AG02", "AG03", "AG04", "AG05",
	"ACT06", "ACT07", "ACT08", "ACT09", "ACT10", "ACT11", "ACT12",
}

var Effects = []string{"solid", "breath", "snake", "rainbow", "gradient", "shallowBreath", "off"}

type Config map[string]any

func loadJSON(name string) (map[string]any, error) {
	data, err := os.ReadFile(filepath.Join(microDir, name))
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func saveJSON(name string, m map[string]any) error {
	data, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	tmp := filepath.Join(microDir, name+".tmp")
	if err := os.WriteFile(tmp, append(data, '\n'), 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, filepath.Join(microDir, name))
}

func LoadConfig() (Config, error)      { return loadJSON("config.json") }
func (c Config) Save() error           { return saveJSON("config.json", c) }
func LoadActions() map[string]any      { m, _ := loadJSON("actions.json"); return m }
func SaveActions(m map[string]any) error { return saveJSON("actions.json", m) }

func (c Config) Keys() map[string]any {
	if k, ok := c["keys"].(map[string]any); ok {
		return k
	}
	k := map[string]any{}
	c["keys"] = k
	return k
}

func (c Config) SetKey(name string, entry map[string]any) {
	c.Keys()[name] = entry
}

func (c Config) GamePort() int {
	if j, ok := c["joystick"].(map[string]any); ok {
		if p, ok := j["gamePort"].(float64); ok {
			return int(p)
		}
	}
	return 4477
}

func (c Config) StatusStyle() map[string]any {
	if s, ok := c["statusStyle"].(map[string]any); ok {
		return s
	}
	return map[string]any{}
}

// DescribeKey renders a key's assignment the way a human reads it.
func DescribeKey(entry any, library map[string]any) string {
	m, ok := entry.(map[string]any)
	if !ok || m == nil {
		return "unassigned"
	}
	if use, ok := m["use"].(string); ok && use != "" {
		if def, ok := library[use]; ok {
			return use + " (library: " + DescribeKey(def, nil) + ")"
		}
		return use + " — missing from actions.json"
	}
	action, _ := m["action"].(string)
	str := func(k string) string { s, _ := m[k].(string); return s }
	switch action {
	case "", "none":
		return "unassigned"
	case "tmux":
		if t := str("target"); t != "" {
			return "pinned to " + t
		}
		if idx, ok := m["index"].(float64); ok {
			return "jump to pane " + itoa(int(idx)+1)
		}
		return "jump to pane"
	case "review":
		effort := str("effort")
		if effort == "" {
			effort = "high"
		}
		return "review (/code-review " + effort + ")"
	case "prompt":
		label := str("label")
		if label == "" {
			label = "prompt"
		}
		return label + " (" + truncate(str("text"), 28) + ")"
	case "approve":
		return "approve dialogs"
	case "deny":
		return "deny dialogs"
	case "command":
		s := "run: " + truncate(str("run"), 30)
		if w, _ := m["window"].(bool); w {
			s += " (window)"
		}
		return s
	case "keys":
		if ks, ok := m["keys"].([]any); ok {
			parts := make([]string, 0, len(ks))
			for _, k := range ks {
				if s, ok := k.(string); ok {
					parts = append(parts, s)
				}
			}
			return "send keys: " + truncate(strings.Join(parts, " "), 26)
		}
		return "send keys"
	}
	return action
}

func itoa(n int) string { return strconv.Itoa(n) }

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// ListSkills scans ~/.claude/skills for SKILL.md files -- the same set the
// node CLI lists, and what the prompt picker offers.
type SkillInfo struct{ Name, Desc string }

func ListSkills() []SkillInfo {
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, ".claude", "skills")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	descRe := regexp.MustCompile(`description:\s*\|?\s*\n?\s*(.+)`)
	var out []SkillInfo
	for _, e := range entries {
		data, err := os.ReadFile(filepath.Join(dir, e.Name(), "SKILL.md"))
		if err != nil {
			continue
		}
		desc := ""
		if m := descRe.FindSubmatch(data); m != nil {
			desc = truncate(strings.TrimSpace(string(m[1])), 56)
		}
		out = append(out, SkillInfo{Name: e.Name(), Desc: desc})
	}
	return out
}
