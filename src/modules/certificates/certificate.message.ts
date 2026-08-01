export const CertificateMessages = {
	NOT_FOUND: "Certificate not found",
	ISSUED: "Certificate issued",
	NO_CERTIFICATE: "This course does not offer certificates",
	COMPLETION_BELOW: (got: number, needed: number) =>
		`Completion ${got}% is below required ${needed}%`,
	QUIZ_BELOW: (got: number, needed: number) =>
		`Quiz score ${got}% is below required ${needed}%`,
	ATTENDANCE_BELOW: (got: number, needed: number) =>
		`Attendance ${got}% is below required ${needed}%`,
};
