export function classifyMiloSubject(subject) {
  const text = String(subject || "").toLocaleLowerCase("es");
  if (/entrevista|interview|oferta laboral|job offer|assessment|evaluaci[oó]n|plazo|deadline/.test(text)) return "high";
  if (/postulaci[oó]n|application|reclut|recruit|vacante|job|empleo|trabajo|hiring/.test(text)) return "medium";
  return "low";
}
