# Status — harness-deck

> Atualizado por mim a cada mudança relevante. Não é histórico; reflete o estado agora.
> Histórico de decisão fica em [plano.md](plano.md) e [analise-inicial.md](analise-inicial.md).

**Última atualização:** 2026-10-12 10:16 (America/Sao_Paulo)

## Agora

- [x] **Item 1.1** — SDK falando com a Avello. Chave via `.env` do projeto (fora do git). Testado
  com `@anthropic-ai/sdk` já instalado no profile do DSH, modelo `claude-sonnet-5`, resposta ok.
- [x] **Item 1.2** — Esqueleto do plugin `harness-deck-claude-code`, commit `ace5e67`.
- [x] **Item 1.3.a** — Sequência real de eventos documentada em
  [event-sequence.md](../packages/harness-deck-claude-code/docs/event-sequence.md): `turn/start` →
  `step/start` → `user/message` → stream (`agent/assistant-stream`, não é `SessionEvent`) →
  `assistant/message` → `step/end` → `turn/end`.
- [ ] **Item 1.3.b** — pausado para decisão do dono (ver "Próxima decisão do dono" abaixo).
- [ ] **REQ-04 (item 3.0)** — Medir plugin/automation task/setting por harness. Ainda não
  disparado.

## Subagentes em segundo plano

_Nenhum em execução._

## Bloqueios

- **Verificação do 1.2 incompleta:** `tsc` não pôde ser executado neste ambiente (sem TypeScript
  instalado, sem rede para `npx` buscar). Revisão foi só leitura manual do código.
- **Esclarecido (lendo `dsh-llm-pi-ai/lib/index.js:2563`):** a chave não é "env vence se os dois
  existirem". A ordem real é: 1) serviço de credenciais do DSH (o que a tela **Models** da própria
  Web GUI grava) — se existir, **sempre** vence; 2) só na ausência desse serviço, cai para o
  ambiente de lançamento do processo (`launchEnvironmentOf`, o que o `dsh web` herdou ao subir).
  Ou seja: se a Avello já foi configurada pela tela Models, o `~/.bashrc` não importa. **Não
  verificado ainda:** se o perfil `web` da porta 3080 tem a Avello guardada assim ou só por env.

## Próxima decisão do dono

- **Achado real ao investigar 1.3.b (lendo `dsh-agent/lib/types/runtime-types.d.ts`):** o `Agent`
  público não é `{ id }` simples — tem `inbox`, `status`, `cancel`, `whenIdle`, `runMaintenance`,
  `send`, `followup`, `steer`, `inject`, e um contrato de eventos inteiro (`agent/created`,
  `agent/status`, `agent/pre-step`, `agent/request`, `agent/assistant-stream`,
  `agent/turn-stopping`, `agent/error`) que o resto do DSH (chat, aprovação, painel de subagentes)
  espera. Implementar isso de verdade é escrever uma segunda versão do que o `dsh-agent-loop` já
  faz em ~2000 linhas, só troca o SDK por dentro — não é "esqueleto + um turno simples", é um
  motor completo. Pedido ao dono: decidir se seguimos mesmo assim (semanas, não dias), se tentamos
  um corte menor que não serve ainda para a UI real (ex.: só confirmar que dá pra criar
  sessão/agente sem crashar, sem turno), ou se reavaliamos a opção C (ponte ACP via
  `claude-code-acp`, que já existe pronta) antes de continuar — o próprio portão do F1 já previa
  essa reavaliação se o B se mostrasse caro demais.
