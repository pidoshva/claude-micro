package main

// The daemon owns the HID device; this client talks to its localhost control
// API (the same server that hosts the game). Nothing here touches hardware.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

type Slot struct {
	Name   string  `json:"name"`
	Action string  `json:"action"`
	Label  *string `json:"label"`
	Kind   string  `json:"kind"`
	Target *string `json:"target"`
	Status *string `json:"status"`
}

type Pane struct {
	Position  int    `json:"position"`
	Coord     string `json:"coord"`
	Command   string `json:"command"`
	HasClaude bool   `json:"hasClaude"`
	Active    bool   `json:"active"`
}

type DaemonState struct {
	Connected      bool                       `json:"connected"`
	Slots          []Slot                     `json:"slots"`
	Panes          []Pane                     `json:"panes"`
	ActionsLibrary map[string]json.RawMessage `json:"actionsLibrary"`
}

type API struct {
	base   string
	client *http.Client
}

func NewAPI(port int) *API {
	return &API{
		base:   fmt.Sprintf("http://127.0.0.1:%d", port),
		client: &http.Client{Timeout: 5 * time.Second},
	}
}

func (a *API) State() (*DaemonState, error) {
	resp, err := a.client.Get(a.base + "/state")
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	var s DaemonState
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		return nil, err
	}
	return &s, nil
}

func (a *API) Press(key string) error {
	body, _ := json.Marshal(map[string]any{"k": key, "act": 1})
	resp, err := a.client.Post(a.base+"/press", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

type PreviewItem struct {
	Color      int     `json:"color"`
	Effect     string  `json:"effect"`
	Speed      float64 `json:"speed"`
	Brightness float64 `json:"brightness"`
}

func (a *API) Preview(item PreviewItem, ms int) error {
	body, _ := json.Marshal(map[string]any{"ms": ms, "items": []PreviewItem{item}})
	resp, err := a.client.Post(a.base+"/preview", "application/json", bytes.NewReader(body))
	if err != nil {
		return err
	}
	resp.Body.Close()
	return nil
}

// NextPress long-polls for the next physical control event; the daemon
// swallows it rather than routing it, so identifying a key never fires it.
// The context lets Esc abandon the wait.
func (a *API) NextPress(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", a.base+"/next-press", nil)
	if err != nil {
		return "", err
	}
	client := &http.Client{Timeout: 32 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("no press seen")
	}
	var out struct {
		K string `json:"k"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return "", err
	}
	return out.K, nil
}
