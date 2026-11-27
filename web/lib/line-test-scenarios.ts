export const lineTestScenarios = {
  first: { documentNo: "Z000000001", birthDate: "1992-06-15" },
  leave: { documentNo: "Z000000005", birthDate: "1990-10-25" },
} as const

export const lineTunnelTestScenarios = {
  first: { documentNo: "Z000000011", birthDate: "1992-06-15" },
  leave: { documentNo: "Z000000015", birthDate: "1990-10-25" },
} as const

export function localLineTestSubject(credential: unknown) {
  switch (credential) {
    case "local.line.first": return "first"
    case "local.line.leave": return "leave"
    case "local.line.other": return "other"
  }
}
