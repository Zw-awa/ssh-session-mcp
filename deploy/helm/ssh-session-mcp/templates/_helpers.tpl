# SPDX-FileCopyrightText: 2026 Zw-awa
# SPDX-License-Identifier: Apache-2.0

{{- define "ssh-session-mcp.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ssh-session-mcp.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := include "ssh-session-mcp.name" . -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "ssh-session-mcp.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "ssh-session-mcp.labels" -}}
helm.sh/chart: {{ include "ssh-session-mcp.chart" . }}
app.kubernetes.io/name: {{ include "ssh-session-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "ssh-session-mcp.selectorLabels" -}}
app.kubernetes.io/name: {{ include "ssh-session-mcp.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "ssh-session-mcp.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "ssh-session-mcp.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "ssh-session-mcp.stateVolumeName" -}}
{{- printf "%s-state" (include "ssh-session-mcp.fullname" .) -}}
{{- end -}}
