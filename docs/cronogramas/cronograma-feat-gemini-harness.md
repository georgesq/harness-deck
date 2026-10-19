# Cronograma — Feature: Harness do Gemini via ACP (F5)

> **Documento de acompanhamento da feature.**  
> **Arquivo:** `docs/cronogramas/cronograma-feat-gemini-harness.md`  
> **Caminho absoluto no WSL:** `/home/georgesq/project/harness-deck/docs/cronogramas/cronograma-feat-gemini-harness.md`  
> **Caminho Windows/UNC:** `\\wsl.localhost\Ubuntu\home\georgesq\project\harness-deck\docs\cronogramas\cronograma-feat-gemini-harness.md`  
> **Data de início:** 19/10/2026  
> **Status geral:** ✅ Concluído e Validado  
> **Regra:** Atualizado continuamente a cada entrega para acompanhamento do dono.

---

## 1. Visão Geral da Feature

Integrar o **Gemini como um harness autônomo** no Harness Deck, completando os itens 5.1 e 5.2 do [`docs/plano.md`](../plano.md) (Fase F5).
O motor opera via **Agent Client Protocol (ACP)** conectado via stdio com o Gemini CLI (`gemini --acp`), incorporando os 3 aprendizados críticos consolidados:
1. **Botão de STOP funcional:** cancelamento real de sessão via ACP (`session/cancel`), fechamento limpo de turno no scheduler e retorno a `idle`.
2. **Indicador de trabalho na GUI:** ciclo estrito de eventos (`status = 'running'`, `turn/start`, `step/start` e frames contínuos de stream com numeração densa).
3. **Visibilidade de Subagentes:** mapeamento e despacho de eventos de sub-tarefas para a interface do DSH não ficar em silêncio.
4. **Liberdade total de Provedor/Modelo:** suporte a chaves diretas do Google (`GEMINI_API_KEY`) e modelos arbitrários via OpenRouter ou gateways locais através de mapeamento e proxy.

---

## 2. Etapas e Status de Execução

| Etapa | Descrição | Status | Entregas / Evidências |
|---|---|---|---|
| **E1** | Criação do pacote `packages/harness-deck-gemini` com esqueleto, tipos e dependências (`@agentclientprotocol/sdk`, `@deepseek-ai/*`) | ✅ Feito | `package.json`, `tsconfig.json`, `README.md`, symlinks de node_modules |
| **E2** | Implementação do loop ACP e ciclo de vida do agente (`GeminiAgent`, `bridge-loop`, cancelamento real via `session/cancel` e indicador de working) | ✅ Feito | `src/bridge-loop.ts`, `src/acp-control.ts`, `src/index.ts` compilando limpo |
| **E3** | Suporte a roteamento de modelos e provedores arbitrários (Google AI Studio / OpenRouter / Gateway) | ✅ Feito | `src/model-proxy.ts`, `applySelectedModel` integrado ao `session/set_config_option` |
| **E4** | Suporte a subagentes e aprovação de ferramentas (`session/request_permission` -> GUI do DSH) | ✅ Feito | Handler de permissão conectado ao serviço `approval` do DSH e tracking de atividade |
| **E5** | Atualização do Launcher (`harness-deck-launcher`): registro, validação de engine `gemini`, materialização de perfil e CLI | ✅ Feito | `registry.ts`, `materialize.ts`, `cli.ts`, sincronização com VS Code |
| **E6** | Testes automatizados (testes de bridge, registry e materialização) | ✅ Feito | 26/26 verificações aprovadas (19 no bridge ACP + 7 no launcher) |
| **E7** | Validação de inicialização de perfil em ambiente isolado | ✅ Feito | Ciclo completo validado: registro salvo/carregado, perfil materializado com `cordis.patch.yml` e symlink |

---

## 3. Log de Atualizações em Tempo Real

* **2026-10-19 09:20:** Criação deste cronograma com os aprendizados e requisitos travados.
* **2026-10-19 09:24:** Conclusão das etapas E1, E2, E3 e E4 no pacote `packages/harness-deck-gemini`. Compilação TypeScript (`tsc -p tsconfig.json`) passou com código de saída 0 sem warnings ou erros.
* **2026-10-19 09:30:** Conclusão da etapa E5 no `harness-deck-launcher` e no `harness-deck-vscode`. Engine `gemini` aceito no CLI, perfis configurados para injeção de plugin via patch e sincronização com a extensão do VS Code validada.
* **2026-10-19 10:05:** Conclusão da subetapa E6.1 (Bridge Tests). Subagente paralelo executou 19 verificações unitárias (`acp-control`, `bridge-loop`, `model-proxy`), todas aprovadas (100% OK).
* **2026-10-19 10:10:** Conclusão da subetapa E6.2 (Launcher Tests). Subagente paralelo executou 7 verificações de schema, variáveis e materialização de patch (`gemini-engine.test.ts`), 100% aprovadas.
* **2026-10-19 10:13:** Conclusão da etapa E7 (Validação de Perfil Isolado). Script end-to-end executado com sucesso gerando profile `package.json`, `cordis.patch.yml` com desabilitação de `agent-loop` e injeção do `harness-deck-gemini`. Feature pronta e homologada.
