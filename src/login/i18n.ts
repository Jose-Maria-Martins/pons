// The words on the sign-in, 2FA, message and privacy pages. To add a language: add it to `Lang`,
// add one table to STRINGS (TypeScript flags a missing key), and add it to LANGUAGES.

export type Lang = "en" | "pt";

export interface Strings {
  /** The `lang` attribute of the page. */
  htmlLang: string;
  title: string;
  /** The intro line. HTML: pass both values already escaped. */
  asking: (client: string, who: string) => string;
  loopback: string;
  passwordNote: string;
  email: string;
  password: string;
  signIn: string;
  signingInLabel: string;
  /** HTML (holds an entity). */
  signingIn: string;
  privacyLink: string;
  mfaIntro: string;
  mfaNote: string;
  code: string;
  verify: string;
  verifyingLabel: string;
  /** HTML (holds an entity). */
  verifying: string;
  // Messages shown as plain text (escaped when rendered).
  badCredentials: string;
  rateLimited: string;
  unavailable: string;
  expired: string;
  noPerson: string;
  tooMany: string;
  replaced: string;
  outOfTries: string;
  invalidLink: string;
  missingLogin: string;
  missingCode: string;
  triesLeft: (n: number) => string;
  // The privacy page. Text here is HTML written by us, never user input.
  privacyTitle: string;
  privacyIntro: string;
  /** Follows the intro when there is a source URL; takes the finished link. */
  openSource: (link: string) => string;
  readTheCode: string;
  collectsH: string;
  collectsLead: string;
  collectsItems: string[];
  userCodeNote: string;
  abuseNote: string;
  storesH: string;
  storesItems: string[];
  neverH: string;
  neverItems: string[];
  deleteH: string;
  deleteText: string;
  contactH: string;
  contactLead: string;
  /** Takes the finished link. */
  contactIssue: (link: string) => string;
  contactSharer: string;
}

export const STRINGS: Record<Lang, Strings> = {
  en: {
    htmlLang: "en",
    title: "Connect your Garmin",
    asking: (client, who) =>
      `<b>${client}</b> (${who}) is asking to read your Garmin data. Pons only reads it; it never changes anything in your Garmin account.`,
    loopback: "This request sends your login to an app on this device. Only continue if you started it.",
    passwordNote: "Your password goes straight to Garmin. Pons never saves it; only a login token is stored, encrypted, so your AI app can read your data.",
    email: "Email",
    password: "Password",
    signIn: "Sign in",
    signingInLabel: "Signing in",
    signingIn: "Signing in to Garmin&hellip; this can take up to a minute.",
    privacyLink: "What Pons collects and stores",
    mfaIntro: "Garmin sent you a verification code (two-step verification). Enter it here to finish connecting.",
    mfaNote: "The code goes straight to Garmin. Pons never saves it.",
    code: "Verification code",
    verify: "Verify",
    verifyingLabel: "Verifying",
    verifying: "Checking the code with Garmin&hellip; this can take up to a minute.",
    badCredentials: "Garmin didn't accept that email or password.",
    rateLimited: "Garmin is limiting login attempts right now. Wait a few minutes and try again.",
    unavailable: "Couldn't reach Garmin. Try again in a moment.",
    expired: "This sign-in page expired. Go back to your AI app and try connecting again.",
    noPerson: "We couldn't confirm you're a person. Please try again.",
    tooMany: "Too many tries. Wait a few minutes and try again.",
    replaced: "This sign-in was replaced by a newer one in another tab or window. Use that one, or go back to your AI app and connect again.",
    outOfTries: "That code didn't work three times. Go back to your AI app and try connecting again.",
    invalidLink: "This sign-in link isn't valid. Go back to your AI app and try connecting again.",
    missingLogin: "Enter your email and password.",
    missingCode: "Enter the code Garmin sent you.",
    triesLeft: (n) => `That code didn't work. You have ${n} ${n === 1 ? "try" : "tries"} left.`,
    privacyTitle: "Pons privacy",
    privacyIntro: "Pons lets AI apps such as Claude, ChatGPT and Gemini read your Garmin Connect data. It is a hobby project run by one person. It is not affiliated with Garmin, Anthropic, OpenAI or Google.",
    openSource: (link) => ` It is open source: ${link}.`,
    readTheCode: "read the code",
    collectsH: "What Pons collects",
    collectsLead: "Usage statistics only, and nothing about your health:",
    collectsItems: [
      "Each time your AI app uses a Pons tool: which tool, whether it worked (or the kind of error), how long it took, a user code, and the kind of device the request came from (desktop, web, mobile or other).",
      "Each time an AI app connects: the name and version of the app.",
      "Each sign-in attempt: the outcome only, such as ok or wrong password.",
    ],
    userCodeNote:
      "The user code is a scrambled code made from your Garmin account id and a secret key. It is not your Garmin id, name or email. Cloudflare keeps these statistics for about three months.",
    abuseNote: "To limit abuse, Pons also counts sign-in attempts per IP address and per scrambled email for a minute. Cloudflare keeps those counters briefly.",
    storesH: "What Pons stores",
    storesItems: [
      "A Garmin login token (not your password), encrypted, in the connection that lets your AI app keep reading your data. It is kept for up to 90 days.",
      'Your Garmin time zone (for example Europe/London), in the same connection, so "today" means your local date.',
      "If your account uses two-step verification, the half-finished sign-in, encrypted, for up to 10 minutes.",
      "Your language choice, if you pick one, in a cookie in your own browser for one year.",
    ],
    neverH: "What Pons never stores",
    neverItems: [
      "Your Garmin password. It goes straight to Garmin and is held in memory for that one request.",
      "Your health data. Pons reads it from Garmin when your AI app asks and passes it on; it does not keep a copy. What your AI app does with it is covered by that app's own privacy policy.",
    ],
    deleteH: "Delete everything",
    deleteText: "Ask your AI app to disconnect Pons. That deletes the stored connection and the Garmin token. Then remove Pons from the app's connector settings.",
    contactH: "Contact",
    contactLead: "Questions or problems: ",
    contactIssue: (link) => `open an issue at ${link}.`,
    contactSharer: "contact the person who shared Pons with you.",
  },
  pt: {
    htmlLang: "pt-PT",
    title: "Ligar a sua conta Garmin",
    asking: (client, who) =>
      `<b>${client}</b> (${who}) está a pedir para ler os seus dados Garmin. O Pons apenas lê; nunca altera nada na sua conta Garmin.`,
    loopback: "Este pedido envia o seu início de sessão para uma aplicação neste dispositivo. Continue apenas se foi você que o iniciou.",
    passwordNote:
      "A sua palavra-passe vai diretamente para a Garmin. O Pons nunca a guarda; só fica guardado um token de acesso, encriptado, para que a sua aplicação de IA possa ler os seus dados.",
    email: "Email",
    password: "Palavra-passe",
    signIn: "Iniciar sessão",
    signingInLabel: "A iniciar sessão",
    signingIn: "A iniciar sessão na Garmin&hellip; pode demorar até um minuto.",
    privacyLink: "O que o Pons recolhe e guarda",
    mfaIntro: "A Garmin enviou-lhe um código de verificação (verificação em dois passos). Introduza-o aqui para concluir a ligação.",
    mfaNote: "O código vai diretamente para a Garmin. O Pons nunca o guarda.",
    code: "Código de verificação",
    verify: "Verificar",
    verifyingLabel: "A verificar",
    verifying: "A confirmar o código com a Garmin&hellip; pode demorar até um minuto.",
    badCredentials: "A Garmin não aceitou esse email ou palavra-passe.",
    rateLimited: "A Garmin está a limitar as tentativas de início de sessão. Aguarde alguns minutos e tente novamente.",
    unavailable: "Não foi possível contactar a Garmin. Tente novamente daqui a pouco.",
    expired: "Esta página de início de sessão expirou. Volte à sua aplicação de IA e tente ligar novamente.",
    noPerson: "Não conseguimos confirmar que é uma pessoa. Tente novamente.",
    tooMany: "Demasiadas tentativas. Aguarde alguns minutos e tente novamente.",
    replaced: "Este início de sessão foi substituído por um mais recente noutro separador ou janela. Use esse, ou volte à sua aplicação de IA e ligue novamente.",
    outOfTries: "Esse código falhou três vezes. Volte à sua aplicação de IA e tente ligar novamente.",
    invalidLink: "Este link de início de sessão não é válido. Volte à sua aplicação de IA e tente ligar novamente.",
    missingLogin: "Introduza o seu email e a palavra-passe.",
    missingCode: "Introduza o código que a Garmin lhe enviou.",
    triesLeft: (n) => (n === 1 ? "Esse código não funcionou. Resta-lhe 1 tentativa." : `Esse código não funcionou. Restam-lhe ${n} tentativas.`),
    privacyTitle: "Privacidade do Pons",
    privacyIntro:
      "O Pons permite que aplicações de IA como o Claude, o ChatGPT e o Gemini leiam os seus dados do Garmin Connect. É um projeto pessoal, mantido por uma pessoa. Não tem qualquer ligação à Garmin, à Anthropic, à OpenAI nem à Google.",
    openSource: (link) => ` É de código aberto: ${link}.`,
    readTheCode: "ver o código",
    collectsH: "O que o Pons recolhe",
    collectsLead: "Apenas estatísticas de utilização, e nada sobre a sua saúde:",
    collectsItems: [
      "Sempre que a sua aplicação de IA usa uma ferramenta do Pons: qual a ferramenta, se funcionou (ou o tipo de erro), quanto tempo demorou, um código de utilizador e o tipo de dispositivo de onde veio o pedido (computador, web, telemóvel ou outro).",
      "Sempre que uma aplicação de IA se liga: o nome e a versão da aplicação.",
      "Cada tentativa de início de sessão: apenas o resultado, como «ok» ou «palavra-passe errada».",
    ],
    userCodeNote:
      "O código de utilizador é um código baralhado, criado a partir do ID da sua conta Garmin e de uma chave secreta. Não é o seu ID, nome nem email da Garmin. A Cloudflare guarda estas estatísticas durante cerca de três meses.",
    abuseNote:
      "Para limitar abusos, o Pons também conta as tentativas de início de sessão por endereço IP e por email baralhado, durante um minuto. A Cloudflare guarda esses contadores por pouco tempo.",
    storesH: "O que o Pons guarda",
    storesItems: [
      "Um token de acesso Garmin (não a sua palavra-passe), encriptado, na ligação que permite à sua aplicação de IA continuar a ler os seus dados. Fica guardado até 90 dias.",
      "O seu fuso horário Garmin (por exemplo Europe/Lisbon), na mesma ligação, para que «hoje» seja a sua data local.",
      "Se a sua conta usa verificação em dois passos, o início de sessão por concluir, encriptado, até 10 minutos.",
      "Se escolher um idioma, essa escolha fica num cookie no seu próprio navegador durante um ano.",
    ],
    neverH: "O que o Pons nunca guarda",
    neverItems: [
      "A sua palavra-passe Garmin. Vai diretamente para a Garmin e só fica em memória durante esse pedido.",
      "Os seus dados de saúde. O Pons lê-os da Garmin quando a sua aplicação de IA os pede e passa-lhos; não guarda nenhuma cópia. O que essa aplicação faz com eles está coberto pela política de privacidade da própria aplicação.",
    ],
    deleteH: "Apagar tudo",
    deleteText: "Peça à sua aplicação de IA para desligar o Pons. Isso apaga a ligação guardada e o token Garmin. Depois, remova o Pons das definições de conectores da aplicação.",
    contactH: "Contacto",
    contactLead: "Dúvidas ou problemas: ",
    contactIssue: (link) => `abra uma issue em ${link}.`,
    contactSharer: "fale com a pessoa que partilhou o Pons consigo.",
  },
};

/** What the language switch shows for each language, written in that language. */
export const LANGUAGES: { lang: Lang; name: string }[] = [
  { lang: "en", name: "English" },
  { lang: "pt", name: "Português" },
];

export const LANG_COOKIE = "__Host-pons_lang";
const isLang = (v: string | null | undefined): v is Lang => v === "en" || v === "pt";

/** The Set-Cookie value that remembers a language choice for a year. */
const langCookie = (lang: Lang): string => `${LANG_COOKIE}=${lang}; Path=/; Max-Age=31536000; Secure; HttpOnly; SameSite=Lax`;

function readLangCookie(request: Request): Lang | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === LANG_COOKIE) {
      const v = value.join("=");
      return isLang(v) ? v : undefined;
    }
  }
  return undefined;
}

/** The best supported language in an Accept-Language header: the highest q wins, the first of equals. */
function fromAcceptLanguage(header: string | null): Lang | undefined {
  let best: { lang: Lang; q: number } | undefined;
  for (const part of (header ?? "").split(",")) {
    const [tag = "", ...params] = part.trim().split(";");
    const primary = tag.trim().toLowerCase().split("-")[0];
    if (!isLang(primary)) continue;
    const qParam = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith("q="));
    const q = qParam ? Number(qParam.slice(2)) : 1;
    if (!(q > 0)) continue;
    if (!best || q > best.q) best = { lang: primary, q };
  }
  return best?.lang;
}

/**
 * Which language to answer in: a valid ?lang= (which is also remembered in a cookie), else the cookie,
 * else Accept-Language, else English.
 */
export function pickLang(request: Request): { lang: Lang; setCookie?: string } {
  const asked = new URL(request.url).searchParams.get("lang");
  if (isLang(asked)) return { lang: asked, setCookie: langCookie(asked) };
  return { lang: readLangCookie(request) ?? fromAcceptLanguage(request.headers.get("Accept-Language")) ?? "en" };
}
