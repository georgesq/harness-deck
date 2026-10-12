# Status — harness-deck

> Atualizado por mim a cada mudança relevante. Não é histórico; reflete o estado agora.
> Histórico de decisão fica em [plano.md](plano.md) e [analise-inicial.md](analise-inicial.md).

**Última atualização:** 2026-10-12 10:16 (America/Sao_Paulo)

## Agora

- [x] **Item 1.1** — SDK falando com a Avello. Chave via `.env` do projeto (fora do git). Testado
  com `@anthropic-ai/sdk` já instalado no profile do DSH, modelo `claude-sonnet-5`, resposta ok.
- [x] **Item 1.2** — Esqueleto do plugin `harness-deck-claude-code`, commit `ace5e67`.
- [ ] **Item 1.3** — Criar sessão de verdade e ver a resposta em streaming no chat. Ainda não
  disparado.
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

- Nenhuma pendente agora.
