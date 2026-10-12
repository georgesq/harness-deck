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
- **Não verificado:** se o `dsh web` real da porta 3080 tem o mesmo problema de não herdar
  `AVELLO_API_KEY` do `~/.bashrc` (resolvido aqui com `.env` do projeto, que não vale para aquele
  processo).

## Próxima decisão do dono

- Nenhuma pendente agora.
