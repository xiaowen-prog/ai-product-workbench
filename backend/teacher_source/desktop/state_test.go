package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// 试玩历史要带上动作卡的 wire 文本，和网页版 toWire 一样拼进同一条 assistant 消息。
func TestChatFromPlayKeepsStepWire(t *testing.T) {
	msgs := []PlayMsg{
		{Role: "user", Text: "明天有面包吗"},
		{Role: "step", Step: map[string]string{"tool": "fetch_input", "wire": "【模拟·调用 fetch_input】"}},
		{Role: "assistant", Text: "有的"},
		{Role: "user", Text: "订两个"},
		{Role: "step", Step: map[string]string{"tool": "x"}}, // 没有 wire 的卡不发
	}
	got := chatFromPlay(msgs)
	want := []ChatMsg{
		{Role: "user", Text: "明天有面包吗"},
		{Role: "assistant", Text: "【模拟·调用 fetch_input】\n有的"},
		{Role: "user", Text: "订两个"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v\nwant %+v", got, want)
	}
}

// 方案页的层号是圈号字符串、工具清单是对象（回归：桌面版按 int / string 解析，方案页整页报错）。
func TestParsePlanMatchesEngineShape(t *testing.T) {
	var raw any
	_ = json.Unmarshal([]byte(`{
		"layers": [{"num": "①", "name": "交互层", "question": "谁在用", "detail": "CLI"}],
		"tool_list": [{"name": "fetch_input", "input": "用户输入", "output": "结构化内容",
		               "side_effect": "无", "permission": "allow", "layer": "⑤"}]
	}`), &raw)
	p, err := parsePlan(raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.Layers[0].Num != "①" || p.ToolList[0].Name != "fetch_input" || p.ToolList[0].Permission != "allow" {
		t.Fatalf("unexpected plan: %+v", p)
	}
}

// 下载交接包不覆盖已有的同名文件。
func TestUniquePathDoesNotOverwrite(t *testing.T) {
	dir := t.TempDir()
	first := uniquePath(dir, "面包店-交接包.zip")
	if err := os.WriteFile(first, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	second := uniquePath(dir, "面包店-交接包.zip")
	if second == first || filepath.Base(second) != "面包店-交接包 (2).zip" {
		t.Fatalf("got %s", second)
	}
}

// 引擎没了就别再无休止地轮询；还连着时容忍偶发失败。
func TestGiveUpPolling(t *testing.T) {
	job := &JobInfo{Status: "running"}
	n := 0
	if giveUpPolling(&n, "http://127.0.0.1:1", job) {
		t.Fatal("一次失败不该放弃")
	}
	if !giveUpPolling(&n, "", job) || job.Status != "failed" || job.Error == "" {
		t.Fatalf("引擎地址为空时应当放弃并写明原因：%+v", job)
	}
	n = 0
	for i := 0; i < 14; i++ {
		if giveUpPolling(&n, "http://x", &JobInfo{Status: "running"}) {
			t.Fatalf("第 %d 次就放弃了", i+1)
		}
	}
	if !giveUpPolling(&n, "http://x", &JobInfo{Status: "running"}) {
		t.Fatal("连续 15 次失败应当放弃")
	}
}
