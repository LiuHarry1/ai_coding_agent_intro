# 新的 README

这是重新创建的 Markdown 文件。


docker build -t ai-coding-agent:latest /Users/harry/cursor_workspace/ai_coding_agent_test


docker run --rm -p 4567:4567 \
  -e OPENAI_API_KEY=你的密钥 \
  ai-coding-agent:latest



# to install ripgrep in windows
winget install BurntSushi.ripgrep.MSVC
# 或者
choco install ripgrep