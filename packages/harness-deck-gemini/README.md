# harness-deck-gemini

Plugin do Harness Deck que expõe o Gemini (via Gemini CLI / ACP) como motor para o `AgentFactory` do DeepSeek Harness (DSH).

## Arquitetura

O plugin atua como uma **ponte ACP (Agent Client Protocol)**:
1. Registra a fábrica de agente (`GeminiAgentLoop`) no `ctx.agents` do DSH.
2. Inicia o subprocesso ACP do Gemini (`gemini --acp` ou binário configurado).
3. Conecta cliente ACP sobre stdio via `@agentclientprotocol/sdk`.
4. Traduz eventos de streaming de texto para `agent/assistant-stream` e `assistant/message`.
5. Traduz requisições de permissão de ferramentas (`session/request_permission`) para o serviço nativo `approval` da Web GUI do DSH.
6. Gerencia o ciclo de cancelamento real via `session/cancel` (botão STOP da GUI).
7. Reporta e traduz atividades de subagentes para os eventos correspondentes do DSH.
