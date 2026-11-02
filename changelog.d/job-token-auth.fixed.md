Fixed AUTH errors after a job by clearing the job-scoped model token at job finish and falling back to the instance token if the gateway rejects a job token.
