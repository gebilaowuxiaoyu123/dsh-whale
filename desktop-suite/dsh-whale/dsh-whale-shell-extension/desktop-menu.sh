#!/usr/bin/env bash
# DSH 小鲸鱼 · 桌面入口：与 GNOME 扩展版联动
UUID=dsh-whale@local

balance_of() {
  local key
  key=$(sed -nE 's/^[[:space:]]*DEEPSEEK_API_KEY[[:space:]]*:[[:space:]]*"?([^"[:space:]#]+)"?.*/\1/p' \
        "$HOME/.dsh/.credentials.yaml" 2>/dev/null | head -1)
  if [ -z "$key" ]; then
    echo "未配置 API Key（~/.dsh/.credentials.yaml）"
    return
  fi
  curl -s --max-time 15 -H "Authorization: Bearer $key" \
       https://api.deepseek.com/user/balance 2>/dev/null | python3 -c \
    'import sys,json
try:
    j=json.load(sys.stdin); i=(j.get("balance_infos") or [{}])[0]
    print("账户余额：¥ %.2f（%s）"%(float(i.get("total_balance")), i.get("currency","CNY")))
except Exception:
    print("余额获取失败（网络或 Key 问题）")' 2>/dev/null || echo "余额获取失败"
}

do_enable()  { gnome-extensions enable "$UUID"  >/dev/null 2>&1; }
do_disable() { gnome-extensions disable "$UUID" >/dev/null 2>&1; }

act="${1:-}"
if [ -z "$act" ]; then
  act=$(zenity --list --title="🐋 DSH 小鲸鱼 · 桌面挂件" --height=300 --width=340 \
        --column="操作" \
        "启用并放回左下角" \
        "禁用（隐藏小鲸鱼）" \
        "查看余额" \
        "操作说明" 2>/dev/null)
fi

case "$act" in
  *左下角*|*启用*)
    do_enable
    zenity --info --title="小鲸鱼" --text="已启用，请查看屏幕左下角。\n\n· 按住拖走 / 单击看余额 / 滚轮缩放" --width=320 2>/dev/null
    ;;
  *禁用*|*隐藏*)
    do_disable
    zenity --info --title="小鲸鱼" --text="已禁用（小鲸鱼隐藏）。\n想恢复：再点本图标选「启用」。" --width=300 2>/dev/null
    ;;
  *余额*)
    zenity --info --title="小鲸鱼余额" --text="$(balance_of)" --width=280 2>/dev/null
    ;;
  *说明*|*帮助*)
    zenity --info --title="操作说明" --width=400 \
      --text="🐋 桌面小鲸鱼（GNOME 扩展版）\n\n· 按住小鲸鱼：牵着它走，松开停\n· 单击：显示余额 + 随机台词\n· 滚轮：缩放大小\n· 拖到屏幕左/右缘松手：贴边转身\n· 开机自动出现在左下角" 2>/dev/null
    ;;
  *) do_enable ;;
esac
