# Spec — harness em qualquer rota de LLM

Origem: pedido do dono em 13/10/2026, na conversa sobre a lista de modelos:

> "é que temos que pensar assim, o HD pode ir para uma rede que pode não funcionar o openrouter,
> daí podemos apontar para outros providers configurado na ferramenta"

O `HD` (o harness-deck) vai rodar em máquina de cliente, em rede de cliente. Se o OpenRouter não
responder dessa rede — bloqueio, proxy, chave corporativa, endpoint interno — o deck não pode ficar
preso a ele. Antes deste escopo, `--provider` aceitava **duas** rotas cravadas no código
(`openrouter` e `deepseek`) e recusava qualquer outra.

---

## 1. O que foi verificado sobre a lista de modelos

Lido no DSH instalado (`0.2.0-rc.2`), em `@earendil-works/pi-ai/dist/providers/all.js`:
`getBuiltinProviders()` devolve um **array** com 41 rotas conhecidas (`openrouter`, `deepseek`,
`anthropic`, `openai`, `google`, `groq`, `mistral`, `ollama`, `lmstudio`, `azure-openai-responses`
e outras). A lista de rotas é do catálogo instalado, **não** do deck.

Em `dsh-llm-pi-ai/lib/index.js`, `resolveRouteModels` decide o que o seletor de modelo oferece:

```js
const entries = configured.length > 0 ? configured : [...defaults.values()];
```

Ou seja: um array `models:` no patch do perfil **substitui** o catálogo daquela rota. `listModels`
lê essa configuração; não é busca viva no provedor. Consequência prática que o dono precisa saber:
um slug errado é oferecido na IDE e só falha na hora do request.

Rota que o catálogo instalado não descreve e que não declara `models` é recusada com
`the installed catalog does not describe this route`.

---

## 2. Requisitos

| | Requisito | Como fica |
| --- | --- | --- |
| **REQ-R1** | A rota do provedor **não é um conjunto fechado**. Qualquer id de rota que o catálogo do pi-ai instalar vale, sem mudança de código no deck. | `kind` deixa de ser `'openrouter' \| 'deepseek'` e passa a `string`, validada por forma (`/^[a-z0-9][a-z0-9-]*$/`, porque vira chave de YAML). |
| **REQ-R2** | O deck traz **padrões** para as rotas que ele consegue adivinhar — chave e protocolo — e não precisa perguntar em runtime o que já sabe. | `PROVIDER_ROUTES` no `registry.ts`: `openrouter`, `deepseek`, `anthropic`, `openai`, `google`, `ollama`, `lmstudio`, cada um com `baseUrl`, `api` e `apiKeyEnv`. A tabela é de atalhos, não de permissões: rota fora dela continua válida. |
| **REQ-R3** | O protocolo de fio **não é fixo em `openai-completions`**. Uma rota Anthropic fala `anthropic-messages`, uma Google fala `google-generative-ai`. | `providerApi(kind, declared)` resolve `--api` → tabela → `openai-completions`. O patch materializado emite o `api` resolvido. |
| **REQ-R4** | Uma rota que o catálogo **não** descreve é aceita **apenas** quando declara onde chamar e o que falar. | `--base-url` + `--api` obrigatórios; sem eles, `normalizeProvider` falha nomeando o campo. A checagem roda no `add`, antes de gravar qualquer arquivo. |
| **REQ-R5** | Endpoint local (Ollama, LM Studio, gateway da casa) não inventa chave obrigatória. | `apiKeyEnv` cai em `LLM_API_KEY` quando a rota não tem convenção própria; rota local não exige chave nenhuma. |
| **REQ-R6** | Trocar de rota **não deixa rastro** da rota antiga no perfil materializado. | `buildProvider` descarta o lembrado quando o `kind` muda; `mergeProfilePatch` regenera `agent-default-model` e `llm-pi-ai` quando a rota muda. |
| **REQ-R7** | O painel e o CLI continuam lendo **o mesmo contrato de registro**. | `registry.ts` passa a ser cópia compartilhada (`sync-shared.mjs` + `shared-copy.test.ts`), como o `process.ts` do REQ-P4. |
| **REQ-R9** | A variável de chave que o deck anuncia — no `add`, no `status` e na resolução do `.env` do painel — é a **da rota**, não a do motor. | `providerApiKeyEnv` só é gravado quando o dono nomeia uma (`--key-env`); senão `credentialEnv` cai na rota. Defeito encontrado ao preparar o teste do Gemini: `--provider google` mandava exportar `DEEPSEEK_API_KEY`. |
| **REQ-R8** | O CLI continua recusando registro que não sobe. | `loadRegistry` segue estrito no CLI; o painel segue tolerante (entrada ruim é descartada da tela, não derruba a view). |

---

## 3. Decisões

- **A lista de rotas não é copiada para dentro do deck.** Ela pertence ao pi-ai instalado. Copiá-la
  obrigaria o deck a acompanhar cada versão nova do pi-ai; a tabela `PROVIDER_ROUTES` guarda só o que
  **não** dá para perguntar em runtime (URL e nome de variável de chave), e uma rota fora dela é
  aceita com `--base-url`/`--api`.
- **Validar no `add`, não no boot.** `saveRegistry` só serializa; sem a checagem no `add`, um registro
  impossível era gravado e só falhava dentro do harness, com mensagem de outra camada. Falhar no
  comando que o dono digitou é a diferença entre uma mensagem acionável e um mistério.
- **Trocar de rota descarta o que era da rota antiga.** Nome de variável de chave e URL são
  propriedade do provedor: mantê-los ao trocar é como a chave do OpenRouter acaba indo para a
  Anthropic. Flag explícita sempre vence.
- **`agent-default-model` acompanha a rota.** O modelo escolhido pelo dono sobrevive à rematerialização
  quando a rota é a mesma; quando a rota muda, o bloco é regenerado, porque `provider: openrouter`
  apontando para um provedor que não existe mais deixa o motor chamando rota não configurada.

---

## 4. Fora de escopo

- Renomear rota já registrada preservando o histórico de sessão do harness.
- Descoberta automática de rotas em runtime (perguntar ao pi-ai instalado quais existem) — hoje a
  validação aceita a forma do id e a tabela dá os atalhos; uma rota desconhecida declara o próprio
  endpoint.
- Interface no painel para trocar provedor. Hoje é `harness-deck add <nome> --force --provider ...`.
