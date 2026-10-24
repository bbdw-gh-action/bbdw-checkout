# Especificação de bbdw-checkout

## Escopo técnico

Aplicação com dados fictícios em memória, contratos HTTP/JSON, build e CI próprios. Autenticação real, banco de dados, pagamentos e mensageria ficam fora do escopo.

## Objetivo e responsabilidade

Consultar clientes e produtos por HTTP, validar o carrinho e criar pedidos fictícios.

É dono dos pedidos. Usa os contratos públicos de users e catalog; não acessa diretamente os dados desses serviços. Não processa pagamentos reais.

Tecnologia: NestJS e TypeScript. Porta local padrão: `3003`. Clientes e produtos são consultados nas APIs de users e catalog. Pedidos retornam confirmação sem persistência ou histórico.

## Interface e regras de negócio

| Método e rota | Resposta esperada |
| --- | --- |
| `GET /health` | 200, `{"status":"ok"}` |
| `POST /orders` | 201, pedido; 422, entrada inválida; 503, dependência indisponível |

A confirmação da interface usa diretamente a resposta de POST /orders; consulta posterior e histórico de pedidos não são necessários.

Requisição:

```json
{"customerId":"customer-pickup","fulfillment":"pickup","items":[{"productId":"product-standard","quantity":2}]}
```

Resposta de criação (ID ilustrativo):

```json
{"id":"order-example","customerId":"customer-pickup","fulfillment":"pickup","deliveryAddress":null,"items":[{"productId":"product-standard","quantity":2,"unitPriceCents":4000}],"totalCents":8000,"currency":"BRL","status":"confirmed"}
```

`fulfillment` aceita `pickup` ou `delivery`. Retirada não exige endereço. Entrega exige endereço no perfil e copia esse endereço para `deliveryAddress`. O carrinho deve ter ao menos um item, quantidades inteiras de 1 a 99 e IDs de produto únicos. O preço vem do catálogo; o cliente não informa o total. Não há frete, desconto ou tributo nesta versão.

Validações retornam 422: `EMPTY_CART`, `ADDRESS_REQUIRED`, `INVALID_QUANTITY`, `DUPLICATE_PRODUCT`, `INVALID_FULFILLMENT`, `CUSTOMER_NOT_FOUND`, `PRODUCT_NOT_FOUND` ou `PRODUCT_UNAVAILABLE`, conforme a causa. Falha de rede ou HTTP 5xx de dependência retorna 503, `DEPENDENCY_UNAVAILABLE`. Use timeout configurável, inicialmente 2 segundos, sem repetição automática de criação de pedidos.

## Contratos comuns

### Intenção de compra

`POST /orders` aceita o cabeçalho opcional `Idempotency-Key` (1–128 caracteres alfanuméricos, ponto, hífen ou sublinhado). Clientes sem chave mantêm o contrato anterior. A chave identifica cliente, modalidade e itens; trocar o conteúdo com a mesma chave retorna `409 IDEMPOTENCY_CONFLICT`. Chave inválida retorna `422 INVALID_IDEMPOTENCY_KEY`.

A reserva ocorre antes das consultas assíncronas. Enquanto uma tentativa está pendente, a repetição retorna `409 CHECKOUT_IN_PROGRESS`. Depois do sucesso, repetir a mesma compra devolve o pedido original com 201, sem nova consulta às dependências. Falhas liberam a reserva para uma tentativa manual. Não há repetição automática.

O armazenamento em memória é limitado a 1000 intenções por instância. Sucessos expiram dez minutos após a conclusão; reservas pendentes não são expulsas para admitir outra operação. Ao atingir o limite, retorna `503 IDEMPOTENCY_CAPACITY`. Reinícios perdem o cache; não existe garantia entre instâncias. `CHECKOUT_DEMO_DELAY_MS` é zero por padrão e pode acrescentar até 5000 ms após a reserva, exclusivamente para ensaio (1500 ms recomendado).

A primeira concorrência de cada tentativa registra uma ocorrência `CheckoutInProgressError` no Sentry; demais repetições pendentes não duplicam a captura. O evento contém hashes da chave e dos IDs de correlação, sem conteúdo da compra. O cabeçalho opcional `X-Client-Release`, aceito apenas como SHA de 40 caracteres, informa a revisão do cliente para diagnóstico; não é uma credencial nem altera a validação do pedido. As outras respostas 4xx continuam sem captura de erro.

- HTTP/JSON, IDs como strings, valores monetários em centavos inteiros e moeda BRL.
- Envelope de erro: `{"error":{"code":"CODIGO_ESTAVEL","message":"Mensagem legível"},"requestId":"identificador"}`.
- Propagar `X-Request-ID` nas chamadas e respostas; gerar um identificador quando ausente.
- Dados exclusivamente fictícios. Não incluir tokens, cabeçalhos de autenticação ou dados pessoais reais nos eventos.
- Cada serviço possui projeto Sentry próprio e identifica ambiente, release e serviço. Consulte [SENTRY.md](SENTRY.md).
- Contratos de erro esperados (4xx) não são falhas inesperadas por padrão. Exceções inesperadas devem ser instrumentadas explicitamente.
- A implementação deve evitar captura duplicada da mesma exceção.

## Observabilidade

Cada serviço usa projeto Sentry próprio. Identificar ambiente, release e serviço; propagar o request ID e evitar eventos duplicados. Publicar source maps associados à mesma release nos projetos TypeScript. Testes de telemetria usam coletores locais, sem credenciais reais.

## Build e CI

`npm ci` e `npm run check` verificam lint, tipos, build e testes HTTP. O workflow [ci.yml](../.github/workflows/ci.yml) também verifica o build da imagem Docker.

Os comandos locais estão no [README](../README.md). A imagem é construída pelo [Dockerfile](../Dockerfile); não há workflow de deploy remoto configurado neste repositório.

## Automação compartilhada

Integração com o Patchwork configurada no workflow local. Consulte [operação, skills e MCP](PATCHWORK.md).
