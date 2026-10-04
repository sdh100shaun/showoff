// Imported before the handler so module-level configuration sees these values.
process.env.KNOWLEDGE_BASE_ID = 'KBTEST1234';
process.env.REQUIRED_SCOPE_PREFIX = 'kb-api';
process.env.MAX_QUERY_LENGTH = '100';
process.env.MAX_RESULTS = '10';
process.env.ALLOWED_FILTER_KEYS = 'department,doc_type';
process.env.LOG_QUERIES = 'false';
process.env.GENERATION_MODEL_ARN = 'arn:aws:bedrock:eu-west-2::foundation-model/example.model-v1:0';
process.env.POWERTOOLS_LOG_LEVEL = 'SILENT';
